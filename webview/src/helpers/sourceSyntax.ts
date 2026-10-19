import { readDocumentTextProjection } from '../application/documentTextProjection';
import { Prec, RangeSetBuilder, StateEffect, type ChangeDesc } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { activateShikiCodeHighlighting, getShikiTokens, getShikiThemeVersion, isShikiThemeReady, requestShikiTokens, subscribeShikiRefresh, type ShikiToken } from './shikiHighlighter';
import { getViewportController } from './viewportController';

const refreshSourceSyntax = StateEffect.define<null>();

// The editor session retains both syntax runtimes across compartment changes.
// Preparation has no decorations, so Source's palette never paints Live text.
export const sourceSyntaxPreparation = ViewPlugin.fromClass(class {
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idle: number | null = null;
  private inView: boolean;
  private document: EditorView['state']['doc'] | undefined;
  private text = '';
  private generation = getShikiThemeVersion('source');
  private readonly releaseSource = activateShikiCodeHighlighting('source');
  private readonly releaseEditor = activateShikiCodeHighlighting('editor');
  private readonly unsubscribe: () => void;

  constructor(private readonly view: EditorView) {
    this.inView = view.inView;
    this.unsubscribe = subscribeShikiRefresh(() => {
      const generation = getShikiThemeVersion('source');
      if (generation !== this.generation) {
        this.generation = generation;
        this.schedule();
      }
    }, 'source');
    this.schedule();
  }

  update(update: ViewUpdate): void {
    const becameVisible = !this.inView && update.view.inView;
    this.inView = update.view.inView;
    if (update.docChanged || becameVisible) this.schedule();
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.idle !== null) cancelIdleCallback(this.idle);
    this.timer = this.idle = null;
  }

  private request(foreground: boolean, isCurrent: () => boolean): boolean {
    const doc = this.view.state.doc;
    if (this.document !== doc) {
      this.document = doc;
      this.text = doc.toString();
    }
    const text = this.text;
    if (getShikiTokens('markdown', text, 'source')) return true;
    requestShikiTokens('markdown', text, 'source', () =>
      !this.destroyed && isCurrent() && this.view.state.doc === doc
      && (foreground || this.view.inView), foreground ? 'foreground' : 'background',
      () => !foreground && Boolean(getViewportController(this.view)?.isUserScrolling()));
    return false;
  }

  private schedule(): void {
    this.cancel();
    if (this.destroyed || !this.view.inView) return;
    // Coalesce typing before entering the browser's idle queue. Hidden editors
    // keep their completed cache, but never prepare unseen document revisions.
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = () => {
        this.idle = null;
        if (!this.destroyed && this.view.inView) this.request(false, () => true);
      };
      if (typeof requestIdleCallback === 'function') this.idle = requestIdleCallback(run, { timeout: 500 });
      else run();
    }, 120);
  }

  async prepare(isCurrent: () => boolean): Promise<boolean> {
    this.cancel();
    const deadline = performance.now() + 10000;
    while (!this.destroyed && isCurrent()) {
      // A missing theme has no syntax palette to wait for (startup/failure path).
      if (!isShikiThemeReady('source') || this.request(true, isCurrent)) return true;
      if (performance.now() >= deadline) throw new Error('Source syntax preparation timed out');
      await new Promise<void>(resolve => setTimeout(resolve, 16));
    }
    return false;
  }

  destroy(): void {
    this.destroyed = true;
    this.cancel();
    this.unsubscribe();
    this.releaseSource();
    this.releaseEditor();
  }
});

/** Prepare the current revision before committing a visible Source transition. */
export function prepareSourceSyntax(view: EditorView, isCurrent: () => boolean): Promise<boolean> {
  return view.plugin(sourceSyntaxPreparation)?.prepare(isCurrent) ?? Promise.resolve(false);
}

/** Markdown uses TextMate's scope stack, including punctuation and embedded grammars.
 * Source owns this runtime so user token customizations cannot recolor Live or Preview.
 */
export const sourceSyntax = Prec.highest(ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  private destroyed = false;
  private readonly release: () => void;
  private readonly unsubscribe: () => void;
  private readonly marks = new Map<string, Decoration>();
  private generation = -1;
  private document: EditorView['state']['doc'] | undefined;
  private text = '';
  private inView: boolean;
  private tokens: readonly (readonly ShikiToken[])[] | undefined;
  private tokenDocument: EditorView['state']['doc'] | undefined;
  private tokenChanges: ChangeDesc | undefined;

  constructor(view: EditorView) {
    this.inView = view.inView;
    this.release = activateShikiCodeHighlighting('source');
    this.build(view);
    this.unsubscribe = subscribeShikiRefresh(() => view.dispatch({ effects: refreshSourceSyntax.of(null) }), 'source');
  }

  update(update: ViewUpdate): void {
    const becameVisible = !this.inView && update.view.inView;
    this.inView = update.view.inView;
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes);
      if (this.tokenDocument) {
        this.tokenChanges = this.tokenChanges?.composeDesc(update.changes) ?? update.changes.desc;
      }
    }
    if (update.docChanged || update.viewportChanged || becameVisible || update.transactions.some(tr => tr.effects.some(effect => effect.is(refreshSourceSyntax)))) {
      this.build(update.view);
    }
  }

  private build(view: EditorView): void {
    const generation = getShikiThemeVersion('source');
    if (generation !== this.generation) {
      this.generation = generation;
      this.marks.clear();
      this.decorations = Decoration.none;
      this.tokens = undefined;
      this.tokenDocument = undefined;
      this.tokenChanges = undefined;
    }
    if (this.document !== view.state.doc) {
      this.document = view.state.doc;
      this.text = readDocumentTextProjection(view.state.doc);
    }
    const doc = this.document;
    // Hidden revisions supersede pending work; tokenize only the latest document on reveal.
    const tokens = getShikiTokens('markdown', this.text, 'source');
    if (!tokens && !view.inView) return;
    if (!tokens) {
      requestShikiTokens('markdown', this.text, 'source', () => !this.destroyed && view.inView && this.document === doc);
    } else {
      this.tokens = tokens;
      this.tokenDocument = doc;
      this.tokenChanges = undefined;
    }
    if (!this.tokens || !this.tokenDocument) return;
    // Retain token paint for insertions while whole-document tokens are pending.
    // Deleted/replaced source invalidates its old formatting immediately.
    const changes = this.tokenChanges;
    const replacedRanges: Array<{ from: number; to: number }> = [];
    const insertions = new Set<number>();
    changes?.iterChangedRanges((from, to, fromNew, toNew) => {
      if (from < to) replacedRanges.push({ from, to });
      else if (fromNew < toNew) insertions.add(from);
    });
    const builder = new RangeSetBuilder<Decoration>();
    // Tokenization retains the full multiline scope stack; only DOM projection
    // is limited to the viewport. Never tokenize a scrolled fragment in isolation.
    const visibleLines = new Set<number>();
    const addLines = (from: number, to: number) => {
      const first = this.tokenDocument!.lineAt(from).number;
      const last = this.tokenDocument!.lineAt(to).number;
      for (let line = first; line <= last; line++) visibleLines.add(line - 1);
    };
    if (changes) {
      // A replacement can map a tiny viewport across the entire old document.
      // Visit only unchanged gaps intersecting the viewport, never deleted text.
      changes.iterGaps((before, after, length) => {
        for (const range of view.visibleRanges) {
          const from = Math.max(range.from, after);
          const to = Math.min(range.to, after + length);
          if (from < to) addLines(before + from - after, before + to - after);
        }
      });
    } else {
      for (const range of view.visibleRanges) addLines(range.from, range.to);
    }
    for (const lineIndex of [...visibleLines].sort((a, b) => a - b)) for (const token of this.tokens[lineIndex] ?? []) {
      const end = token.offset + token.content.length;
      if (replacedRanges.some(range => range.from < end && range.to > token.offset)) continue;
      // Only pure insertions inherit a boundary token. The preceding token owns
      // them except at a line start, where no preceding character is available.
      const ownsStart = insertions.has(token.offset) && token.offset === this.tokenDocument.line(lineIndex + 1).from;
      const from = changes?.mapPos(token.offset, ownsStart ? -1 : 1) ?? token.offset;
      const to = changes?.mapPos(end, insertions.has(end) ? 1 : -1) ?? end;
      if (from >= to || !view.visibleRanges.some(range => from < range.to && to > range.from)) continue;
      const font = token.fontStyle ?? 0;
      const style = `color:${token.color ?? 'var(--meo-source-foreground)'} !important;-webkit-text-fill-color:currentColor !important;font-style:${font & 1 ? 'italic' : 'normal'} !important;font-weight:${font & 2 ? '700' : 'var(--meo-font-source-weight)'} !important;text-decoration:${[font & 4 ? 'underline' : '', font & 8 ? 'line-through' : ''].filter(Boolean).join(' ') || 'none'} !important`;
      let mark = this.marks.get(style);
      if (!mark) {
        mark = Decoration.mark({ class: 'meo-source-token', attributes: { style } });
        this.marks.set(style, mark);
      }
      builder.add(from, to, mark);
    }
    this.decorations = builder.finish();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.release();
  }
}, { decorations: plugin => plugin.decorations }));
