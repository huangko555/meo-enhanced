import { readDocumentTextProjection } from '../application/documentTextProjection';
import {
  RangeSetBuilder,
  StateEffect,
  Prec,
  type EditorState,
  type Extension,
  type Transaction
} from '@codemirror/state';
import { Decoration, ViewPlugin, EditorView, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import {
  resolveShikiLang,
  getShikiTokens,
  requestShikiTokens,
  activateShikiCodeHighlighting,
  isShikiThemeReady,
  subscribeShikiRefresh,
  getShikiThemeMeta,
  getShikiThemeVersion,
  type ShikiToken
} from './shikiHighlighter';
import {
  isLiveInputDerivedWorkRefresh,
  isLiveInputDerivedWorkPending,
  isMappedLiveInputRefresh,
  mapLiveInputDerivedDecorations,
  shouldDeferLiveInputDerivedWork,
  usesLargeDocumentDerivedWorkBudget
} from '../editor/liveInputDerivedWork';
import { getFencedCodeBodyRange, getFencedCodeInfo, syntaxTreeChanged } from './markdownSyntax';
import { getCodeBlockSourceLines } from './blockIndent';
import { getViewportController } from './viewportController';
import { collectDocumentMathRanges, getDisplayMathCopySource, getDisplayMathSource, getMathCompletionBody } from './displayMathBlocks';

export const shikiRefreshEffect = StateEffect.define<null>();

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const pendingTokenDecoration = Decoration.mark({
  attributes: {
    style: 'color:var(--meo-token-foreground-color,var(--vscode-editor-foreground))'
  }
});

function pendingDocumentTokenDecoration(language: string): Decoration {
  return Decoration.mark({
    attributes: {
      style: 'color:var(--meo-token-foreground-color,var(--vscode-editor-foreground))'
    },
    shikiLanguage: language,
    shikiThemeVersion: getShikiThemeVersion()
  });
}

function addPendingDocumentTokenDecorations(
  decorations: DecorationSet,
  transaction: Transaction,
  language: string
): DecorationSet {
  const added: Array<ReturnType<typeof pendingTokenDecoration.range>> = [];
  const fallback = pendingDocumentTokenDecoration(language);
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (fromB >= toB) return;
    const startLine = transaction.newDoc.lineAt(fromB).number;
    const endLine = transaction.newDoc.lineAt(Math.max(fromB, toB - 1)).number;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const line = transaction.newDoc.line(lineNumber);
      const from = Math.max(fromB, line.from);
      const to = Math.min(toB, line.to);
      if (from >= to) continue;
      let inherited: Decoration | null = null;
      let covered = false;
      decorations.between(Math.max(0, from - 1), to, (start, end, decoration) => {
        if (
          decoration.spec.shikiLanguage !== language
          || decoration.spec.shikiThemeVersion !== getShikiThemeVersion()
        ) return;
        if (start <= from && end >= to) covered = true;
        if (start <= from && end >= from) inherited = decoration;
      });
      if (!covered) added.push((inherited ?? fallback).range(from, to));
    }
  });
  return added.length > 0 ? decorations.update({ add: added, sort: true }) : decorations;
}

function isFencedCodeAt(state: EditorState, position: number): boolean {
  const boundedPosition = Math.max(0, Math.min(position, state.doc.length));
  const probes = boundedPosition > 0 ? [boundedPosition, boundedPosition - 1] : [boundedPosition];
  for (const probe of probes) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(probe, -1);
    while (node) {
      if (node.name === 'FencedCode') {
        return true;
      }
      node = node.parent;
    }
  }
  return false;
}

function addPendingTokenDecorations(
  decorations: DecorationSet,
  transaction: Transaction
): DecorationSet {
  const added: Array<ReturnType<typeof pendingTokenDecoration.range>> = [];
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (fromB >= toB) return;
    const wasFencedCode = isFencedCodeAt(transaction.startState, fromA)
      || isFencedCodeAt(transaction.startState, toA);
    const isFencedCode = isFencedCodeAt(transaction.state, fromB)
      || isFencedCodeAt(transaction.state, toB);
    let hadAcceptedToken = false;
    decorations.between(Math.max(0, fromB - 1), toB, (_from, _to, decoration) => {
      if (decoration.spec.shikiLanguage && decoration.spec.shikiThemeVersion === getShikiThemeVersion()) hadAcceptedToken = true;
    });
    // Consecutive keys can see placeholder trees on both sides of the edit.
    // A mapped token from this theme still proves the local highlighting surface;
    // keep its style until the existing worker publishes authoritative tokens.
    if (!wasFencedCode && !isFencedCode && !hadAcceptedToken) return;

    const startLine = transaction.newDoc.lineAt(fromB).number;
    const endLine = transaction.newDoc.lineAt(Math.max(fromB, toB - 1)).number;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const line = transaction.newDoc.line(lineNumber);
      const from = Math.max(fromB, line.from);
      const to = Math.min(toB, line.to);
      if (from < to) {
        let inherited: Decoration | null = null;
        let covered = false;
        decorations.between(Math.max(0, from - 1), to, (start, end, decoration) => {
          if (!decoration.spec.shikiLanguage || decoration.spec.shikiThemeVersion !== getShikiThemeVersion()) return;
          if (start <= from && end >= to) covered = true;
          if (start <= from && end >= from) inherited = decoration;
        });
        if (!covered) added.push((inherited ?? pendingTokenDecoration).range(from, to));
      }
    }
  });
  return added.length > 0 ? decorations.update({ add: added, sort: true }) : decorations;
}

function tokenStyle(token: ShikiToken): string {
  let style = token.color ? `color:${token.color}` : '';
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & FONT_STYLE_ITALIC) {
    style += ';font-style:italic';
  }
  if (fontStyle & FONT_STYLE_BOLD) {
    style += ';font-weight:bold';
  }
  if (fontStyle & FONT_STYLE_UNDERLINE) {
    style += ';text-decoration:underline';
  }
  return style;
}

function addTokenDecorations(
  builder: RangeSetBuilder<Decoration>,
  markCache: Map<string, Decoration>,
  lang: string,
  code: string,
  contentFrom: number,
  contentTo: number,
  previous: DecorationSet = Decoration.none,
  allowUnseen: () => boolean = () => true,
  isNeeded: () => boolean = () => true,
  sourceLines?: readonly { from: number; to: number }[]
): void {
  const tokens = getShikiTokens(lang, code);
  if (!tokens) {
    // Keep the mapped presentation until this revision's tokens are ready.
    // Only matching language/theme identities may enter the rebuilt result.
    let preservedPresentation = false;
    let hadPresentation = false;
    previous.between(contentFrom, contentTo, (from, to, decoration) => {
      if (decoration.spec.shikiLanguage) hadPresentation = true;
      if (decoration.spec.shikiLanguage !== lang || decoration.spec.shikiThemeVersion !== getShikiThemeVersion()) return;
      const start = Math.max(contentFrom, from);
      const end = Math.min(contentTo, to);
      if (start < end) {
        preservedPresentation = true;
        builder.add(start, end, decoration);
      }
    });
    // A hidden editor's mapped viewport may cover the whole replacement document.
    // Maintain known blocks and a bounded preparation of newly introduced code.
    if (!hadPresentation && !allowUnseen()) return;
    if (isNeeded()) requestShikiTokens(lang, code, 'editor', isNeeded);
    // On first paint there is no completed Shiki presentation to preserve.
    // Cover the block with one neutral foreground until the requested token
    // set arrives, so CodeMirror's language parser cannot briefly expose a
    // different semantic palette.
    if (!preservedPresentation) {
      const pending = pendingDocumentTokenDecoration(lang);
      let offset = 0;
      for (const [index, line] of code.split('\n').entries()) {
        if (line.length > 0) {
          const from = sourceLines?.[index]?.from ?? contentFrom + offset;
          builder.add(from, from + line.length, pending);
        }
        offset += line.length + 1;
      }
    }
    return;
  }

  const meta = getShikiThemeMeta();
  const bracketColors = meta.bracketColors;
  const numBracketColors = bracketColors.length;

  const addMark = (from: number, to: number, style: string): void => {
    if (from >= to || !style) {
      return;
    }
    if (lang === 'meo-math') {
      // Markdown/quote marks must not override the exposed TeX token palette.
      style = ('font-style:normal;font-weight:var(--meo-font-source-weight);text-decoration:none;' + style)
        .split(';').map(rule => rule + ' !important').join(';') + ';-webkit-text-fill-color:currentColor !important';
    }
    const key = `${lang}:${style}`;
    let deco = markCache.get(key);
    if (!deco) {
      deco = Decoration.mark({ class: lang === 'meo-math' ? 'meo-math-token' : '', attributes: { style }, shikiLanguage: lang, shikiThemeVersion: getShikiThemeVersion() });
      markCache.set(key, deco);
    }
    builder.add(from, to, deco);
  };

  let depth = 0;

  let lineOffset = 0;
  const codeLines = sourceLines ? code.split('\n') : [];
  for (const [index, line] of tokens.entries()) {
    for (const token of line) {
      const content = token.content;
      if (!content) {
        continue;
      }
      const tokenFrom = sourceLines ? sourceLines[index]!.from + token.offset - lineOffset : contentFrom + token.offset;
      if (tokenFrom < contentFrom || tokenFrom + content.length > contentTo) {
        continue;
      }
      const baseStyle = tokenStyle(token);
      const inStringOrComment = token.isStringComment === true;

      if (numBracketColors === 0 || inStringOrComment) {
        if (content.trim()) {
          addMark(tokenFrom, tokenFrom + content.length, baseStyle);
        }
        continue;
      }

      let spanStart = 0;
      for (let i = 0; i < content.length; i += 1) {
        const ch = content[i];
        const isOpen = ch === '(' || ch === '[' || ch === '{';
        const isClose = ch === ')' || ch === ']' || ch === '}';
        if (!isOpen && !isClose) {
          continue;
        }
        if (i > spanStart && content.slice(spanStart, i).trim()) {
          addMark(tokenFrom + spanStart, tokenFrom + i, baseStyle);
        }
        let bracketColor: string;
        if (isOpen) {
          bracketColor = bracketColors[depth % numBracketColors];
          depth += 1;
        } else if (depth === 0) {
          bracketColor = meta.unexpectedBracket;
        } else {
          depth -= 1;
          bracketColor = bracketColors[depth % numBracketColors];
        }
        addMark(tokenFrom + i, tokenFrom + i + 1, `color:${bracketColor}`);
        spanStart = i + 1;
      }
      if (content.length > spanStart && content.slice(spanStart).trim()) {
        addMark(tokenFrom + spanStart, tokenFrom + content.length, baseStyle);
      }
    }
    if (sourceLines) lineOffset += codeLines[index]!.length + 1;
  }
}

function addMathTokenDecorations(
  view: EditorView,
  builder: RangeSetBuilder<Decoration>,
  markCache: Map<string, Decoration>,
  from: number,
  to: number,
  prefix: string,
  previous: DecorationSet,
  allowUnseen: () => boolean,
  isNeeded: () => boolean
): void {
  if (from >= to) return;
  const doc = view.state.doc, lines: Array<{ from: number; to: number }> = [];
  const code: string[] = [];
  for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
    const line = doc.line(number);
    let start = Math.max(from, line.from);
    const end = Math.min(to, line.to);
    if (start === line.from && prefix) {
      if (line.text.startsWith(prefix)) start += prefix.length;
      else if (line.text === prefix.trimEnd()) start = end;
    }
    lines.push({ from: start, to: end });
    code.push(doc.sliceString(start, end));
  }
  // Container prefixes stay Markdown; only TeX payload receives math scopes.
  addTokenDecorations(builder, markCache, 'meo-math', code.join('\n'), from, to,
    previous, allowUnseen, isNeeded, lines);
}

function addBlockDecorations(
  view: EditorView,
  node: SyntaxNodeRef,
  builder: RangeSetBuilder<Decoration>,
  markCache: Map<string, Decoration>,
  previous: DecorationSet,
  allowUnseen: () => boolean,
  isNeeded: () => boolean
): void {
  const { state } = view;
  if (node.name === 'CodeBlock') {
    // Indented code has no fence rows to exclude and no language info string.
    for (const content of node.node.getChildren('CodeText')) {
      builder.add(content.from, content.to, pendingTokenDecoration);
    }
    return;
  }
  const info = getFencedCodeInfo(state, node);
  const body = getFencedCodeBodyRange(state, node.node);
  if (!body) return;
  const { from: contentFrom, to: contentTo } = body;
  if (contentFrom >= contentTo) {
    return;
  }

  const lang = resolveShikiLang(info);
  if (!lang) {
    const style = 'color:var(--meo-token-foreground-color,var(--vscode-editor-foreground))';
    let deco = markCache.get(style);
    if (!deco) {
      deco = Decoration.mark({ attributes: { style } });
      markCache.set(style, deco);
    }
    for (let lineNumber = state.doc.lineAt(contentFrom).number; lineNumber <= state.doc.lineAt(contentTo).number; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (line.from < line.to) builder.add(line.from, line.to, deco);
    }
    return;
  }

  if (lang === 'mermaid') {
    const lines = getCodeBlockSourceLines(state, node.node).filter(line => !line.isFence);
    const code = lines.map(line => state.doc.sliceString(line.prefixTo, line.to)).join('\n');
    addTokenDecorations(builder, markCache, lang, code, contentFrom, contentTo, previous, allowUnseen, isNeeded,
      lines.map(line => ({ from: line.prefixTo, to: line.to })));
    return;
  }
  const code = state.doc.sliceString(contentFrom, contentTo);
  addTokenDecorations(builder, markCache, lang, code, contentFrom, contentTo, previous, allowUnseen, isNeeded);
}

function buildDecorations(
  view: EditorView,
  previous: DecorationSet,
  allowUnseen: () => boolean,
  canHighlight: () => boolean
): DecorationSet {
  if (!isShikiThemeReady()) {
    return Decoration.none;
  }
  const builder = new RangeSetBuilder<Decoration>();
  const markCache = new Map<string, Decoration>();
  const doc = view.state.doc;
  const isNeeded = () => view.state.doc === doc && canHighlight();
  try {
    const math = collectDocumentMathRanges(view.state);
    const bodies = math.map(range => {
      const source = range.fencedDisplay ? getDisplayMathCopySource(view.state, range) : null;
      return { from: source?.from ?? range.from + (range.mode === 'display' ? 2 : 1),
        to: source?.to ?? range.to - (range.mode === 'display' ? 2 : 1),
        prefix: range.fencedDisplay ? getDisplayMathSource(view.state, range)?.prefix ?? '' : '' };
    });
    const head = view.state.selection.main.head;
    if (!math.some(range => range.from <= head && range.to >= head)) {
      const incomplete = getMathCompletionBody(view.state, head);
      if (incomplete) bodies.push(incomplete);
    }
    const entries: Array<{ from: number; to: number; node?: SyntaxNodeRef; prefix?: string }> = bodies
      .filter(range => range.from < view.viewport.to && range.to > view.viewport.from);
    syntaxTree(view.state).iterate({
      from: view.viewport.from,
      to: view.viewport.to,
      enter(node) {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
          if (!bodies.some(body => body.from < node.to && body.to > node.from)) {
            entries.push({ from: node.from, to: node.to, node: node.node.cursor() });
          }
          return false;
        }
        return undefined;
      }
    });
    for (const entry of entries.sort((left, right) => left.from - right.from)) {
      if (entry.node) addBlockDecorations(view, entry.node, builder, markCache, previous, allowUnseen, isNeeded);
      else addMathTokenDecorations(view, builder, markCache, entry.from, entry.to, entry.prefix ?? '', previous, allowUnseen, isNeeded);
    }
  } catch {
    return Decoration.none;
  }
  return builder.finish();
}

const shikiPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private inView: boolean;
    private destroyed = false;
    private caretFrame: number | null = null;
    private caretPending = false;
    private highlightRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly canHighlight = (): boolean => {
      if (this.destroyed) return false;
      if (!(usesLargeDocumentDerivedWorkBudget(this.view.state)
        && (this.caretPending || isLiveInputDerivedWorkPending(this.view.state)))
        && !getViewportController(this.view)?.isUserScrolling()) return true;
      // First-use grammar compilation can exceed a frame even for a short
      // fence. Keep its current presentation while native reading or primary
      // input owns the frame, then retry from the current document and viewport.
      if (this.highlightRetryTimer === null) {
        this.highlightRetryTimer = setTimeout(() => {
          this.highlightRetryTimer = null;
          if (this.canHighlight()) this.view.dispatch({ effects: shikiRefreshEffect.of(null) });
        }, 50);
      }
      return false;
    };
    deferHighlightForCaret(): void {
      if (!usesLargeDocumentDerivedWorkBudget(this.view.state)) return;
      if (this.caretFrame !== null) window.cancelAnimationFrame(this.caretFrame);
      this.caretPending = true;
      this.caretFrame = window.requestAnimationFrame(() => {
        this.caretFrame = window.requestAnimationFrame(() => {
          this.caretFrame = null;
          this.caretPending = false;
          // canHighlight's timer retries in a later task. Do not compile a cold
          // grammar in this second frame before the caret has actually painted.
        });
      });
      this.canHighlight();
    }
    private prepareUnseen = true;
    private readonly allowUnseen: () => boolean;
    private readonly unsubscribe: () => void;
    private readonly releaseHighlighting: () => void;

    constructor(private readonly view: EditorView) {
      this.inView = view.inView;
      this.allowUnseen = () => {
        if (view.inView) return true;
        const allowed = this.prepareUnseen;
        this.prepareUnseen = false;
        return allowed;
      };
      this.releaseHighlighting = activateShikiCodeHighlighting();
      this.decorations = buildDecorations(view, Decoration.none, this.allowUnseen, this.canHighlight);
      this.unsubscribe = subscribeShikiRefresh(() => {
        view.dispatch({ effects: shikiRefreshEffect.of(null) });
      });
    }

    update(update: ViewUpdate): void {
      const becameVisible = !this.inView && update.view.inView;
      this.inView = update.view.inView;
      // One unseen block per document revision protects first-use preparation.
      // Token refreshes must not restart that budget and eventually warm all fences.
      if (update.docChanged) this.prepareUnseen = true;
      for (const transaction of update.transactions) {
        if (transaction.docChanged) {
          this.decorations = addPendingTokenDecorations(
            mapLiveInputDerivedDecorations(this.decorations, transaction), transaction
          );
        }
      }
      if (update.transactions.some(transaction => isMappedLiveInputRefresh(transaction) || shouldDeferLiveInputDerivedWork(transaction))) {
        return;
      }
      const refreshed = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(shikiRefreshEffect))
          || isLiveInputDerivedWorkRefresh(transaction)
          || syntaxTreeChanged(transaction)
      );
      if (update.docChanged || update.selectionSet || update.viewportChanged || refreshed || becameVisible) {
        this.decorations = buildDecorations(update.view, this.decorations, this.allowUnseen, this.canHighlight);
      }
    }

    destroy(): void {
      this.destroyed = true;
      if (this.caretFrame !== null) window.cancelAnimationFrame(this.caretFrame);
      if (this.highlightRetryTimer !== null) clearTimeout(this.highlightRetryTimer);
      this.unsubscribe();
      this.releaseHighlighting();
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventObservers: { pointerdown() { this.deferHighlightForCaret(); } }
  }
);

export const shikiCodeHighlight = Prec.high(shikiPlugin);

/** Projects the shared editor Shiki palette onto an editor whose whole document is one language. */
export function shikiDocumentHighlight(language: string): Extension {
  const lang = resolveShikiLang(language);
  if (!lang) return [];

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly unsubscribe: () => void;
      private destroyed = false;
      private readonly releaseHighlighting: () => void;

      constructor(view: EditorView) {
        this.releaseHighlighting = activateShikiCodeHighlighting();
        this.decorations = this.build(view);
        this.unsubscribe = subscribeShikiRefresh(() => {
          view.dispatch({ effects: shikiRefreshEffect.of(null) });
        });
      }

      update(update: ViewUpdate): void {
        for (const transaction of update.transactions) {
          if (transaction.docChanged) {
            this.decorations = addPendingDocumentTokenDecorations(
              this.decorations.map(transaction.changes),
              transaction,
              lang
            );
          }
        }
        const refreshed = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(shikiRefreshEffect))
        );
        if (update.docChanged || refreshed) {
          this.decorations = this.build(update.view, this.decorations);
        }
      }

      destroy(): void {
        this.destroyed = true;
        this.unsubscribe();
        this.releaseHighlighting();
      }

      private build(view: EditorView, previous: DecorationSet = Decoration.none): DecorationSet {
        if (!isShikiThemeReady() || view.state.doc.length === 0) {
          return Decoration.none;
        }
        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        addTokenDecorations(
          builder,
          new Map<string, Decoration>(),
          lang,
          readDocumentTextProjection(view.state.doc),
          0,
          view.state.doc.length,
          previous,
          () => true,
          () => !this.destroyed && view.state.doc === doc
        );
        return builder.finish();
      }
    },
    { decorations: (value) => value.decorations }
  );

  return Prec.high(plugin);
}
