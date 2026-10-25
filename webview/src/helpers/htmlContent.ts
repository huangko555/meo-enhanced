import { documentLines } from './documentLines';
import { mapLiveWidgetPositions } from '../editor/liveWidgetPositions';
import { EditorState, Prec, StateEffect, StateField, type ChangeDesc } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  keymap,
  lineNumberWidgetMarker,
  type DecorationSet
} from '@codemirror/view';
import { IterMode, type SyntaxNodeRef, type Tree } from '@lezer/common';
import { markdownStructureIdentity } from '../editor/markdownStructure';
import { invertedEffects, isolateHistory } from '@codemirror/commands';
import { parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';
import { createElement, AlertTriangle } from 'lucide';
import {
  getHtmlRootTagName,
  isSafeHtmlUrl,
  isSupportedHtmlAttribute,
  isSupportedHtmlBlockSource,
  isSupportedHtmlSource,
  inspectHtmlStyle,
  normalizeHtmlAlign,
  supportedHtmlBlockTags,
  supportedHtmlTags
} from '../../../src/shared/htmlPolicy';
import { scanHtmlTags, splitHtmlBlockFragments } from '../../../src/foundation/htmlSyntax';
import { renderHtmlMarkdown } from '../../../src/shared/htmlMarkdown';
import { createOpenLinkButton } from './linkOpenButton';
import { isPrimaryModifierPointerClick } from './linkNavigation';
import { currentSyntaxTree, resolvedSyntaxTree, resolvedSyntaxTreeAt } from './markdownSyntax';
import { indexSourceRanges } from './sourceRangeIndex';
import { getViewportController } from './viewportController';
import { ImageWidget, disposeImagePresentations } from './images';
import { getImagePresentationFactory } from '../editor/imagePresentation';
import { getDetailsBlocks, toggleDetailsBlock } from './detailsBlocks';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { estimateBlockWidgetHeight } from '../editor/blockWidgetHeight';
import { formatSourceLineNumber } from '../editor/sourceLineNumbers';
import { mountProjectedLineNumbers } from '../editor/projectedLineNumbers';
import { RenderedBlockPreviewHeight } from './renderedBlockPreview';
import { createPreviewTableLayoutController, type PreviewTableLayoutController } from './previewTableLayout';
import { formatHtmlFragment } from '../editor/htmlFormatting';
import { createSourceFormatButton, type SourceFormatOutcome } from '../editor/sourceFormatButton';
import { isLivePointerSelectionActive, setLivePointerSelectionActiveEffect, sourcePresentationSelection } from '../editor/livePointerSelection';
import { blockReadingFocusAt, enterBlockSource, focusBlockReading } from '../editor/blockInteraction';

export interface RenderableHtmlBlock {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  source: string;
  detailsCollapsed: boolean | null;
  visible: boolean;
}

export interface HtmlEditingRange {
  from: number;
  to: number;
}

const renderableHtmlBlockCache = new WeakMap<EditorState['doc'], {
  tree: Tree;
  tabSize: number;
  details: ReturnType<typeof getDetailsBlocks>;
  blocks: RenderableHtmlBlock[];
}>();

type HtmlCommentRange = { from: number; to: number };

function maskHtmlComments(source: string): { source: string; comments: HtmlCommentRange[] } | null {
  if (!source.includes('<!--')) return { source, comments: [] };
  const comments: HtmlCommentRange[] = [];
  const visit = (nodes: readonly ChildNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'comment' && node.startIndex !== null && node.endIndex !== null) {
        const raw = source.slice(node.startIndex, node.endIndex + 1);
        if (raw.startsWith('<!--') && raw.endsWith('-->')) {
          comments.push({ from: node.startIndex, to: node.endIndex + 1 });
        }
      }
      if ('children' in node) visit(node.children);
    }
  };
  visit(parseDocument(source, { withStartIndices: true, withEndIndices: true }).children);
  comments.sort((left, right) => left.from - right.from);
  if (comments.length === 0) return null;
  let cursor = 0;
  let masked = '';
  for (const comment of comments) {
    if (source.slice(cursor, comment.from).includes('<!--')) return null;
    masked += source.slice(cursor, comment.from);
    masked += source.slice(comment.from, comment.to).replace(/[^\r\n]/g, ' ');
    cursor = comment.to;
  }
  if (source.slice(cursor).includes('<!--')) return null;
  return { source: masked + source.slice(cursor), comments };
}

function isSupportedHtmlWithComments(source: string): boolean {
  const masked = maskHtmlComments(source);
  return masked !== null && isSupportedHtmlSource(masked.source);
}

function htmlHasVisibleContent(source: string): boolean {
  const transparent = (color: string): boolean => color.toLowerCase() === 'transparent'
    || /^#[\da-f]{3}0$/i.test(color) || /^#[\da-f]{6}00$/i.test(color)
    || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?%?\s*\)$/i.test(color)
    || /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
  const hasInk = (color: string, inherited: boolean): boolean =>
    /^(?:inherit|unset|currentcolor)$/i.test(color) ? inherited : !transparent(color);
  type Paint = { visible: boolean; layout: boolean };
  const paint = (node: ChildNode, ink = true, font = true, shown = true,
    inherited: Readonly<Record<string, string>> = {}, direction: 'ltr' | 'rtl' = 'ltr'): Paint => {
    if (node.type === 'comment') return { visible: shown && font, layout: font };
    if (node.type === 'text') {
      const layout = Boolean(node.data.trim()) && font;
      return { visible: layout && ink && shown, layout };
    }
    if (!('children' in node) || !('attribs' in node)) return { visible: false, layout: false };
    if (node.attribs.dir === 'rtl' || node.attribs.dir === 'ltr') direction = node.attribs.dir;
    const style = { ...inspectHtmlStyle(node.attribs.style ?? '', direction).properties };
    for (const [name, value] of Object.entries(style)) {
      if (/^inherit$/i.test(value)) style[name] = inherited[name] ?? '';
      else if (/^(?:initial|unset)$/i.test(value)) {
        const initial = name === 'display' ? 'inline' : /^initial$/i.test(value)
          ? ({ color: 'initial', visibility: 'visible', 'font-size': 'medium' } as Record<string, string>)[name] : undefined;
        if (initial) style[name] = initial; else delete style[name];
      }
    }
    if ('hidden' in node.attribs || style.display?.toLowerCase() === 'none' || style.opacity !== undefined
      && Number.parseFloat(style.opacity) === 0) {
      return { visible: false, layout: false };
    }
    const color = style.color ? hasInk(style.color, ink) : ink;
    const size = style['font-size'];
    const textSize = size ? (!Number.isFinite(parseFloat(size)) || parseFloat(size) > 0)
      && (font || !/(?:em|ex|ch|lh|%)$/i.test(size) || /(?:rem|rlh)$/i.test(size)) : font;
    const visibility = style.visibility ? style.visibility.toLowerCase() === 'visible' : shown;
    const display = style.display?.toLowerCase() || (supportedHtmlBlockTags.has(node.name) ? 'block' : 'inline');
    style.display = display;
    const children = node.children.map(child => paint(child, color, textSize, visibility, style, direction));
    const media = ['img', 'hr', 'br', 'table', 'li'].includes(node.name);
    const borders = ['top', 'right', 'bottom', 'left'].map(side => {
      const kind = style[`border-${side}-style`]?.toLowerCase() ?? 'none';
      const width = style[`border-${side}-width`] ?? 'medium';
      const layout = kind !== 'none' && kind !== 'hidden' && (/^(?:thin|medium|thick)$/i.test(width) || parseFloat(width) > 0);
      return { layout, visible: layout && hasInk(style[`border-${side}-color`] ?? 'currentcolor', color) };
    });
    const blockBox = display === 'block' || display === 'inline-block';
    const paddedWidth = ['padding-left', 'padding-right'].some(name => parseFloat(style[name] ?? '0') > 0);
    const sizedBox = (blockBox && Math.max(parseFloat(style.height ?? style['block-size'] ?? '0') || 0, parseFloat(style['min-height'] ?? style['min-block-size'] ?? '0') || 0) > 0
      || ['padding-top', 'padding-bottom'].some(name => parseFloat(style[name] ?? '0') > 0)
      || !blockBox && textSize && paddedWidth
      || blockBox && parseFloat(style.width ?? '0') > 0 && style['aspect-ratio'] !== undefined && style['aspect-ratio'] !== 'auto')
      && (display === 'block' || paddedWidth || parseFloat(style.width ?? '0') > 0);
    const layout = media || sizedBox || borders.some(border => border.layout) || children.some(child => child.layout);
    const background = style['background-color'];
    return { layout, visible: children.some(child => child.visible)
      || visibility && (media || borders.some(border => border.visible) || Boolean(background && hasInk(background, color) && layout)) };
  };
  return parseDocument(source).children.some(node => paint(node).visible);
}

function selectedHtmlBlock(state: EditorState): HtmlEditingRange | undefined {
  if (blockReadingFocusAt(state)?.kind === 'html') return undefined;
  const { head } = sourcePresentationSelection(state).main;
  // This guard runs during every native edit/selection transaction. Ordinary
  // Markdown must not complete the whole parse or rediscover unrelated HTML.
  const tree = currentSyntaxTree(state);
  let node = tree.cursor(IterMode.IgnoreMounts).moveTo(head, head === state.doc.length ? -1 : 1).node;
  let html = false;
  for (;;) {
    if (node.name === 'HTMLBlock' || node.name === 'Paragraph'
      && state.doc.sliceString(node.from, Math.min(node.to, node.from + 4)).trimStart().startsWith('<')) { html = true; break; }
    if (!node.parent) break;
    node = node.parent;
  }
  if (!html) return undefined;
  const block = collectRenderableHtmlBlocks(state, tree).find(block => head >= block.from && head < block.to);
  if (block) return block;
  const details = getDetailsBlocks(state).find(block => head >= block.anchorFrom && head < block.anchorTo
    || head >= block.closingFrom && head < block.closingTo);
  return details ? { from: details.sectionFrom, to: details.sectionTo } : undefined;
}

export const setHtmlEditingRangeEffect = StateEffect.define<HtmlEditingRange | null>({
  map: (range, changes) => range && ({ from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) })
});

export const htmlEditingRangeField = StateField.define<HtmlEditingRange | null>({
  create() {
    return null;
  },
  update(value, transaction) {
    const previous = value ?? selectedHtmlBlock(transaction.startState);
    let replaced = false;
    if (previous) transaction.changes.iterChangedRanges((from, to) => {
      if (from <= previous.from && to >= previous.to) replaced = true;
    });
    let next = previous && !replaced
      ? { from: transaction.changes.mapPos(previous.from, -1), to: transaction.changes.mapPos(previous.to, 1) }
      : null;
    let explicitlySet = false;
    for (const effect of transaction.effects) {
      if (effect.is(setHtmlEditingRangeEffect)) {
        next = effect.value;
        explicitlySet = true;
      }
    }
    if (!next || explicitlySet || isLivePointerSelectionActive(transaction.state)) return next;
    const pointerReleased = transaction.effects.some(effect => effect.is(setLivePointerSelectionActiveEffect) && !effect.value.active);
    if (!transaction.selection && !pointerReleased) return next;
    const head = transaction.state.selection.main.head;
    return head >= next.from && head <= next.to ? next : null;
  }
});

export function getHtmlEditingRange(state: EditorState): HtmlEditingRange | null {
  if (blockReadingFocusAt(state)?.kind === 'html') return null;
  return state.field(htmlEditingRangeField, false) ?? selectedHtmlBlock(state) ?? null;
}

// Keep the new fragment open in the paste transaction itself, including when
// the native caret lands in trailing blank lines. The next selection/input owns exit.
const htmlPasteSourceEditing = EditorState.transactionExtender.of(transaction => {
  if (!transaction.isUserEvent('input.paste') || !transaction.docChanged || transaction.state.readOnly
    || transaction.state.selection.ranges.length !== 1 || !transaction.state.selection.main.empty) return null;
  const inserted: Array<{ from: number; to: number }> = [];
  transaction.changes.iterChangedRanges((_from, _to, from, to) => {
    if (transaction.state.doc.sliceString(from, to).includes('<')) inserted.push({ from, to });
  });
  if (!inserted.length) return null;
  const head = transaction.state.selection.main.head;
  const block = collectRenderableHtmlBlocks(transaction.state).filter(block => block.to <= head
    && !transaction.state.doc.sliceString(block.to, head).trim()
    && inserted.some(range => block.to > range.from && block.from < range.to && head <= range.to)).at(-1);
  return block ? { effects: setHtmlEditingRangeEffect.of({ from: block.from, to: block.to }) } : null;
});

const htmlSourceEditingHistory = invertedEffects.of(transaction => transaction.docChanged
  && transaction.effects.some(effect => effect.is(setHtmlEditingRangeEffect))
  ? [setHtmlEditingRangeEffect.of(getHtmlEditingRange(transaction.startState))] : []);

export function collectRenderableHtmlBlocks(state: EditorState, tree: Tree = resolvedSyntaxTree(state), scope?: { from: number; to: number }): RenderableHtmlBlock[] {
  const details = getDetailsBlocks(state);
  const cached = scope ? undefined : renderableHtmlBlockCache.get(state.doc);
  if (cached && cached.tree === markdownStructureIdentity(tree) && cached.tabSize === state.tabSize
    && cached.details === details) return cached.blocks;
  const blocks: RenderableHtmlBlock[] = [];
  let detailsByAnchor: Map<number, ReturnType<typeof getDetailsBlocks>[number]> | undefined;
  const nodes: Array<{ from: number; to: number; standalone?: boolean }> = [];
  tree.iterate({ ...scope, enter(node: SyntaxNodeRef) {
    if (node.name === 'HTMLBlock') nodes.push({ from: node.from, to: node.to });
    else if (node.name === 'Paragraph') {
      const source = state.doc.sliceString(node.from, node.to);
      if (!source.trimStart().startsWith('<')) return;
      const fragments = splitHtmlBlockFragments(source);
      let cursor = 0;
      for (const fragment of fragments) {
        if (source.slice(cursor, fragment.from).trim()) return;
        cursor = fragment.to;
      }
      if (fragments.length && !source.slice(cursor).trim()) nodes.push({ from: node.from, to: node.to, standalone: true });
    }
  } });
  // Adjacent raw HTML tokens separated only by blank lines still form one HTML
  // fragment. Markdown paragraphs between them keep their CommonMark ownership.
  const groups: typeof nodes = [];
  for (const node of nodes) {
    const previous = groups.at(-1);
    if (previous && !previous.standalone && !node.standalone && !state.doc.sliceString(previous.to, node.from).trim()) {
      const source = state.doc.sliceString(previous.from, previous.to);
      const fragments = splitHtmlBlockFragments(source);
      const incomplete = !fragments.length || Boolean(source.slice(fragments.at(-1)!.to).trim());
      if (incomplete && supportedHtmlTags.has(getHtmlRootTagName(source) ?? '')) {
        previous.to = node.to;
        continue;
      }
    }
    groups.push({ ...node });
  }
  for (const node of groups) {
    const parsedSource = state.doc.sliceString(node.from, node.to);
    const masked = maskHtmlComments(parsedSource);
    if (!masked) continue;
    const fragments = splitHtmlBlockFragments(masked.source);
    // A single rendered source line cannot host two independent block widgets.
    for (let index = 1; index < fragments.length; index++) {
      const previous = fragments[index - 1], current = fragments[index];
      if (!parsedSource.slice(previous.to, current.from).includes('\n')) {
        previous.to = current.to;
        fragments.splice(index--, 1);
      }
    }
    for (const fragment of fragments) {
      const source = parsedSource.slice(fragment.from, fragment.to);
      if (!(node.standalone ? isSupportedHtmlSource : isSupportedHtmlBlockSource)(masked.source.slice(fragment.from, fragment.to))) continue;
      const visible = htmlHasVisibleContent(renderHtmlMarkdown(source));
      // Inline tags retain ordinary line editing, even when alone in a
      // paragraph. Only an invisible standalone fragment needs a source row.
      if (node.standalone && visible) continue;
      const from = node.from + fragment.from, to = node.from + fragment.to;
      detailsByAnchor ??= new Map(details.map(block => [block.anchorFrom, block] as const));
      const detailsBlock = detailsByAnchor.get(from) ?? null;
      blocks.push({
        from,
        to,
        startLine: state.doc.lineAt(from).number,
        endLine: state.doc.lineAt(Math.max(node.from, to - 1)).number,
        source,
        detailsCollapsed: detailsBlock?.collapsed ?? null,
        visible
      });
    }
  }
  blocks.sort((left, right) => left.from - right.from);
  if (!scope) renderableHtmlBlockCache.set(state.doc, { tree: markdownStructureIdentity(tree), tabSize: state.tabSize, details, blocks });
  return blocks;
}

function currentHtmlBlock(view: EditorView, source: string, startLine: number): RenderableHtmlBlock | undefined {
  // A retained widget may outlive edits before it; absolute offsets in its original block then go stale.
  return collectRenderableHtmlBlocks(view.state).find((block) => (
    block.startLine === startLine && block.source === source
  ));
}

type HtmlContentIssue = { kind: 'tag' | 'attribute' | 'style' | 'value' | 'url'; name: string };

function sanitizeElementTree(root: ParentNode): HtmlContentIssue[] {
  const issues: HtmlContentIssue[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const tagName = element.tagName.toLowerCase();
    if (!supportedHtmlTags.has(tagName)) {
      issues.push({ kind: 'tag', name: tagName });
      element.replaceWith(document.createTextNode(element.outerHTML));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!isSupportedHtmlAttribute(tagName, name)) {
        issues.push({ kind: 'attribute', name: `${tagName}.${name}` });
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && !isSafeHtmlUrl(attribute.value, name)) {
        issues.push({ kind: 'url', name: `${tagName}.${name}` });
        element.removeAttribute(attribute.name);
      }
      if (name === 'align') {
        const align = normalizeHtmlAlign(attribute.value);
        if (align) element.setAttribute('align', align);
        else {
          issues.push({ kind: 'value', name: `${tagName}.${name}` });
          element.removeAttribute(attribute.name);
        }
      }
      if (name === 'style') {
        const inspected = inspectHtmlStyle(attribute.value);
        issues.push(...inspected.unsupported.map(name => ({ kind: 'style' as const, name })),
          ...inspected.invalid.map(name => ({ kind: 'value' as const, name })));
        const style = inspected.style;
        if (style) element.setAttribute('style', style);
        else element.removeAttribute('style');
      }
    }
  }
  return issues;
}

function htmlSourceIssues(source: string): HtmlContentIssue[] {
  const template = document.createElement('template');
  template.innerHTML = source;
  return sanitizeElementTree(template.content);
}

function htmlIssueDescription(view: EditorView, issues: HtmlContentIssue[]): string {
  const strings = getUiStrings(view.state.facet(uiLanguageFacet));
  const describe = { tag: strings.htmlUnsupportedTag, attribute: strings.htmlUnsupportedAttribute,
    style: strings.htmlUnsupportedStyle, value: strings.htmlInvalidValue, url: strings.htmlBlockedUrl };
  return strings.htmlFilteredContent([...new Set(issues.map(issue => describe[issue.kind](issue.name)))]);
}

export async function formatActiveHtmlSource(view: EditorView, isCurrent: () => boolean = () => true): Promise<SourceFormatOutcome> {
  const range = getHtmlEditingRange(view.state);
  const { doc, selection, readOnly } = view.state;
  const trailingCaret = range && selection.main.empty && selection.main.head >= range.to
    && !doc.sliceString(range.to, selection.main.head).trim();
  if (!range || readOnly || selection.ranges.length !== 1 || selection.main.from < range.from
    || selection.main.to > range.to && !trailingCaret) return 'unavailable';
  try {
    const source = doc.sliceString(range.from, range.to);
    const offsets = [selection.main.anchor - range.from, selection.main.head - range.from];
    const result = await formatHtmlFragment(source, offsets.map(offset => Math.min(offset, source.length)));
    const current = getHtmlEditingRange(view.state);
    if (!isCurrent() || !view.dom.isConnected || view.state.readOnly || view.state.doc !== doc || !view.state.selection.eq(selection)
      || current?.from !== range.from || current.to !== range.to) return 'changed';
    if (result.kind !== 'formatted' && result.kind !== 'formatted-protected') return result.kind;
    preserveHtmlPosition(view, range.from, () => view.dispatch({
      changes: { from: range.from, to: range.to, insert: result.source },
      selection: { anchor: range.from + result.offsets[0] + Math.max(0, offsets[0] - source.length),
        head: range.from + result.offsets[1] + Math.max(0, offsets[1] - source.length) },
      effects: setHtmlEditingRangeEffect.of({ from: range.from, to: range.from + result.source.length }),
      annotations: isolateHistory.of('full'), userEvent: 'input.format'
    }));
    return result.kind;
  } catch { return 'invalid'; }
}

type HtmlSourceActionsElement = HTMLSpanElement & { formatControl?: ReturnType<typeof createSourceFormatButton> };

class HtmlSourceActionsWidget extends UiLanguageSensitiveWidget {
  constructor(readonly source: string) { super(); }
  eq(other: WidgetType): boolean {
    return other instanceof HtmlSourceActionsWidget && this.hasSameUiLanguageEpoch(other) && other.source === this.source;
  }
  private refresh(root: HTMLElement, view: EditorView): void {
    const range = getHtmlEditingRange(view.state);
    const issues = htmlSourceIssues(range ? view.state.doc.sliceString(range.from, range.to) : this.source);
    const warning = root.querySelector<HTMLElement>('.meo-md-html-warning')!;
    warning.hidden = !issues.length;
    warning.dataset.tooltip = issues.length ? htmlIssueDescription(view, issues) : '';
    warning.setAttribute('aria-label', warning.dataset.tooltip);
    (root as HtmlSourceActionsElement).formatControl?.refresh();
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('span') as HtmlSourceActionsElement;
    root.className = 'meo-md-html-source-actions';
    root.contentEditable = 'false';
    const warning = document.createElement('span');
    warning.className = 'meo-md-html-warning';
    warning.dataset.tooltipKind = 'description';
    warning.append(createElement(AlertTriangle, { width: 14, height: 14, 'aria-hidden': 'true' }));
    const control = createSourceFormatButton(view, `html:${getHtmlEditingRange(view.state)?.from}`, () => view.state.doc, root.ownerDocument, () => {
      const strings = getUiStrings(view.state.facet(uiLanguageFacet));
      return { idle: strings.formatHtml, busy: strings.formattingHtml,
        formatted: strings.formattedHtml, 'formatted-protected': strings.htmlFormattedProtected, unchanged: strings.htmlFormatUnchanged,
        boundary: strings.htmlFormatBoundary, unsafe: strings.htmlFormatUnsafe, unsupported: strings.htmlFormatInvalid, invalid: strings.htmlFormatInvalid,
        changed: strings.htmlFormatChanged, unavailable: strings.htmlFormatUnavailable };
    }, current => formatActiveHtmlSource(view, current));
    root.formatControl = control;
    control.button.classList.add('meo-format-html-btn');
    root.append(warning, control.button);
    root.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    this.refresh(root, view);
    return root;
  }
  updateDOM(root: HTMLElement, view: EditorView): boolean { this.refresh(root, view); return true; }
  destroy(root: HTMLElement): void { (root as HtmlSourceActionsElement).formatControl?.dispose(); }
}

function annotateHtmlSourceLines(root: ParentNode, source: string, startLine: number): void {
  const openingTags = scanHtmlTags(source).filter((tag) => !tag.closing);
  const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
  let tagCursor = 0;
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    const tagIndex = openingTags.findIndex((tag, index) => index >= tagCursor && tag.name === tagName);
    if (tagIndex < 0) continue;
    const tag = openingTags[tagIndex];
    tagCursor = tagIndex + 1;
    const relativeLine = source.slice(0, tag.from).split('\n').length - 1;
    element.dataset.meoHtmlSourceLine = String(startLine + relativeLine);
  }
}

function bindHtmlReadingClick(root: HTMLElement, activate: (event: MouseEvent) => void): void {
  let pointer: { x: number; y: number } | null = null;
  root.addEventListener('pointerdown', event => {
    if (event.button === 0) pointer = { x: event.clientX, y: event.clientY };
  });
  root.addEventListener('click', event => {
    const start = pointer;
    pointer = null;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || !start && event.detail > 0
      || start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    const selection = root.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed
      && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))) return;
    activate(event);
  });
}

function showHtmlComments(
  root: DocumentFragment,
  comments: readonly HtmlCommentRange[],
  view: EditorView,
  source: string,
  sourceFrom: number,
  inline: boolean,
  sourceStartLine: number
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const nodes: Comment[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Comment);
  const sidecarTails = new Map<Element, Element>();
  for (const [index, comment] of comments.entries()) {
    const note = document.createElement('span');
    note.className = 'meo-md-html-comment';
    note.dataset.meoHtmlSourceLine = String(sourceStartLine + source.slice(0, comment.from).split('\n').length - 1);
    note.textContent = source.slice(comment.from, comment.to);
    const openSource = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      if (inline) {
        view.dispatch({ selection: { anchor: sourceFrom + comment.from } });
        view.focus();
        return;
      }
      const current = currentHtmlBlock(view, source, sourceStartLine);
      if (current) enterHtmlSource(view, current, current.from + comment.from);
    };
    bindHtmlReadingClick(note, openSource);
    const node = nodes[index];
    if (!node) {
      note.dataset.display = 'block';
      root.append(note);
      continue;
    }
    const parent = node.parentElement;
    const structuralParent = parent?.closest('table')
      ?? parent?.closest('ul, ol')
      ?? parent?.closest('a, summary');
    if (structuralParent) {
      note.dataset.display = 'block';
      const tail = sidecarTails.get(structuralParent) ?? structuralParent;
      tail.after(note);
      sidecarTails.set(structuralParent, note);
      node.remove();
      continue;
    }
    note.dataset.display = parent?.matches('p, span, strong, b, em, i, code, kbd, li, td, th') ? 'inline' : 'block';
    node.replaceWith(note);
  }
}

function enhanceLinks(root: ParentNode, inline: boolean, uiLanguage: UiLanguage): void {
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (!isSafeHtmlUrl(href, 'href') || !htmlHasVisibleContent(anchor.outerHTML)) continue;
    const linkText = document.createElement('span');
    linkText.className = 'meo-md-link meo-md-html-link';
    linkText.dataset.meoLinkHref = href;
    linkText.dataset.tooltip = anchor.title || anchor.dataset.tooltip || '';
    linkText.dataset.tooltipKind = 'description';
    for (const name of ['id', 'title', 'style', 'hidden', 'lang', 'dir']) {
      if (anchor.hasAttribute(name)) linkText.setAttribute(name, anchor.getAttribute(name)!);
    }
    linkText.append(...Array.from(anchor.childNodes));
    linkText.addEventListener('pointerdown', (event) => {
      if (event.button === 0 && isPrimaryModifierPointerClick(event)) {
        // Native selection can unmount inline HTML before the click arrives.
        event.preventDefault();
      }
    });
    linkText.addEventListener('click', (event) => {
      if (!isPrimaryModifierPointerClick(event)) return;
      event.preventDefault();
      linkText.dispatchEvent(new CustomEvent('meo-open-link', { bubbles: true, detail: { href } }));
    });
    const button = createOpenLinkButton(href, uiLanguage);
    button.classList.add(inline ? 'meo-md-html-inline-link-button' : 'meo-md-html-link-button');
    anchor.replaceWith(linkText, button);
  }
}

function enhanceImages(
  root: ParentNode, view: EditorView, sourceFrom: number, sourceStartLine: number, source: string
): void {
  const resolveSourceFrom = () => currentHtmlBlock(view, source, sourceStartLine)?.from ?? null;
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const rawSrc = image.getAttribute('src')?.trim() ?? '';
    if (!isSafeHtmlUrl(rawSrc, 'src')) continue;
    const anchor = image.closest<HTMLAnchorElement>('a[href]');
    const linkUrl = anchor?.getAttribute('href')?.trim() ?? '';
    const displayImageStyle = ['object-fit', 'object-position', 'aspect-ratio', 'border-radius',
      'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius']
      .flatMap(name => {
        const value = image.style.getPropertyValue(name);
        return value ? [`${name}: ${value}`] : [];
      }).join('; ');
    const widget = new ImageWidget(
      rawSrc,
      image.getAttribute('alt') ?? '',
      isSafeHtmlUrl(linkUrl, 'href') ? linkUrl : '',
      sourceFrom,
      getImagePresentationFactory(view.state),
      { uiLanguage: view.state.facet(uiLanguageFacet), sourceFromResolver: resolveSourceFrom, displayImageStyle }
    );
    const container = widget.toDOM(view);
    container.classList.add('meo-md-html-image');
    for (const name of ['id', 'hidden', 'lang', 'dir']) {
      if (image.hasAttribute(name)) container.setAttribute(name, image.getAttribute(name)!);
    }
    const style = image.getAttribute('style');
    if (style) {
      container.style.cssText = style;
    }
    if (image.hasAttribute('hidden')) container.style.display = 'none';
    if (image.dataset.meoHtmlSourceLine) {
      container.dataset.meoHtmlSourceLine = image.dataset.meoHtmlSourceLine;
    }
    const width = image.getAttribute('width')?.trim() ?? '';
    if (!container.style.width && /^\d+(?:\.\d+)?$/.test(width)) {
      container.style.width = `${width}px`;
    }
    const height = image.getAttribute('height')?.trim() ?? '';
    if (!container.style.height && /^\d+(?:\.\d+)?$/.test(height)) container.style.height = `${height}px`;
    if (container.style.width) container.style.setProperty('--meo-html-image-width', '100%');
    if (container.style.height) {
      container.style.setProperty('--meo-html-image-height', '100%');
      container.style.setProperty('--meo-html-image-max-height', 'none');
    }
    if (container.style.aspectRatio && !/^(?:auto|initial|unset)$/.test(container.style.aspectRatio)) {
      container.style.setProperty('--meo-html-image-max-height', 'none');
    }
    const anchorOnlyContainsImage = anchor && Array.from(anchor.childNodes).every((node) => (
      node === image || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    ));
    if (anchorOnlyContainsImage) {
      const wrapper = document.createElement('span');
      for (const name of ['id', 'title', 'style', 'hidden', 'lang', 'dir']) {
        if (anchor.hasAttribute(name)) wrapper.setAttribute(name, anchor.getAttribute(name)!);
      }
      wrapper.append(container);
      anchor.replaceWith(wrapper);
    } else image.replaceWith(container);
  }
}

function createSanitizedHtml(
  source: string,
  inline: boolean,
  uiLanguage: UiLanguage,
  view?: EditorView,
  sourceFrom = 0,
  sourceStartLine = 1
): DocumentFragment | null {
  const masked = maskHtmlComments(source);
  const rendered = renderHtmlMarkdown(source, inline);
  const renderedMask = maskHtmlComments(rendered);
  if (!masked || !renderedMask || !isSupportedHtmlSource(renderedMask.source)) return null;
  const template = document.createElement('template');
  template.innerHTML = rendered;
  sanitizeElementTree(template.content);
  annotateHtmlSourceLines(template.content, masked.source, sourceStartLine);
  if (view && masked.comments.length) {
    showHtmlComments(template.content, masked.comments, view, source, sourceFrom, inline, sourceStartLine);
  }
  if (view) enhanceImages(template.content, view, sourceFrom, sourceStartLine, source);
  enhanceLinks(template.content, inline, uiLanguage);
  return template.content;
}

function preserveHtmlPosition(view: EditorView, from: number, mutate: () => void): void {
  const controller = getViewportController(view);
  const resolveElement = (): HTMLElement | null => {
    const position = Math.min(from, view.state.doc.length);
    const dom = view.domAtPos(position);
    const node = dom.node.nodeType === Node.TEXT_NODE ? dom.node : dom.node.childNodes[dom.offset] ?? dom.node;
    const element = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>('.cm-line, .meo-md-html-block');
    if (!element) return null;
    const start = view.posAtDOM(element);
    return start === position || start === view.state.doc.lineAt(position).from ? element : null;
  };
  const element = controller && resolveElement();
  if (controller && element) controller.preserveElementPositionWhileMutation(element, resolveElement, mutate, 'next-frame', true);
  else if (controller) controller.preservePositionWhileMutation(from, mutate);
  else mutate();
}

export function enterHtmlSource(view: EditorView, block: HtmlEditingRange, anchor?: number, viewportTop?: number): void {
  const currentSelection = view.state.selection;
  const selection = anchor === undefined && currentSelection.ranges.every((range) => (
    range.from >= block.from && range.to <= block.to
  )) ? currentSelection : { anchor: anchor ?? block.from };
  enterBlockSource(view, { kind: 'html', ...block }, viewportTop === undefined
    ? view.coordsAtPos(view.state.selection.main.head)?.top ?? null : viewportTop - view.defaultLineHeight / 2, () => {
    view.dispatch({
      selection,
      effects: setHtmlEditingRangeEffect.of({ from: block.from, to: block.to }),
      scrollIntoView: false
    });
  });
  view.focus();
}

type HtmlTableLayout = { frame: number | null; controller: PreviewTableLayoutController | null };
// CodeMirror may retain a widget's DOM while replacing its equal value object.
const htmlTableLayouts = new WeakMap<HTMLElement, HtmlTableLayout>();

class HtmlBlockWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType {
    const from = changes.mapPos(this.block.from, 1), to = changes.mapPos(this.block.to, -1);
    const startLine = state.doc.lineAt(from).number, endLine = state.doc.lineAt(Math.max(from, to - 1)).number;
    if (from === this.block.from && to === this.block.to && startLine === this.block.startLine && endLine === this.block.endLine) return this;
    const next = new HtmlBlockWidget({ ...this.block, from, to, startLine, endLine }, this.editing);
    next.seedHeight(this);
    return next;
  }
  private readonly height: RenderedBlockPreviewHeight;

  constructor(readonly block: RenderableHtmlBlock, readonly editing = false) {
    super();
    this.height = new RenderedBlockPreviewHeight(JSON.stringify(['html', block.source, block.detailsCollapsed]));
  }

  seedHeight(previous: HtmlBlockWidget): void {
    this.height.seed(previous.height);
  }

  get estimatedHeight(): number {
    return estimateBlockWidgetHeight({
      kind: 'html-block',
      source: this.block.source,
      collapsed: this.block.detailsCollapsed === true,
      measuredHeight: this.height.height
    });
  }

  eq(other: WidgetType): boolean {
    return other instanceof HtmlBlockWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.block.startLine === this.block.startLine &&
      other.editing === this.editing &&
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'meo-md-html-block';
    root.dataset.meoRenderedBlockKind = 'html';
    root.dataset.meoRenderedBlockStartLine = String(this.block.startLine);
    root.dataset.meoRenderedBlockEndLine = String(this.block.endLine);
    root.classList.toggle('meo-md-html-live-result', this.editing);
    if (this.editing) {
      const label = document.createElement('span');
      label.className = 'meo-md-html-result-status';
      label.textContent = getUiStrings(view.state.facet(uiLanguageFacet)).preview;
      root.append(label);
    }
    const contentRoot = document.createElement('div');
    contentRoot.className = 'meo-md-html-content';
    const content = createSanitizedHtml(
      this.block.source,
      false,
      view.state.facet(uiLanguageFacet),
      view,
      this.block.from,
      this.block.startLine
    );
    if (content) {
      const firstElement = content.firstElementChild as HTMLElement | null;
      const align = normalizeHtmlAlign(firstElement?.getAttribute('align') ?? null);
      if (align) root.style.textAlign = align;
      contentRoot.appendChild(content);
    }
    root.appendChild(contentRoot);

    const details = contentRoot.querySelector<HTMLDetailsElement>(':scope > details');
    const summary = details?.querySelector<HTMLElement>(':scope > summary') ?? null;
    if (summary) {
      const label = document.createElement('span');
      label.className = 'meo-md-details-summary-label';
      label.append(...Array.from(summary.childNodes));
      const icon = document.createElement('span');
      icon.className = 'meo-md-details-summary-icon';
      icon.setAttribute('aria-hidden', 'true');
      summary.append(icon, label);
    }
    if (details && this.block.detailsCollapsed !== null) {
      details.open = !this.block.detailsCollapsed;
      details.addEventListener('toggle', () => {
        const currentBlock = currentHtmlBlock(view, this.block.source, this.block.startLine);
        if (!currentBlock) return;
        const collapsed = getDetailsBlocks(view.state)
          .find((block) => block.anchorFrom === currentBlock.from)?.collapsed;
        if (collapsed === undefined || details.open === !collapsed) return;
        toggleDetailsBlock(view, currentBlock.from);
      });
    }

    // Wait until pointerup/click so native dragging can select rendered text.
    // Interactive HTML keeps its own reading action and never opens source.
    root.addEventListener('pointerdown', event => {
      if (event.button === 0 && this.editing) event.preventDefault();
    });
    bindHtmlReadingClick(root, event => {
      const target = event.target instanceof Element ? event.target : null;
      if (this.editing
        || target?.closest('summary, button, a, input, select, textarea, .meo-md-html-comment, .meo-md-image')) return;
      const currentBlock = currentHtmlBlock(view, this.block.source, this.block.startLine);
      if (!currentBlock) return;
      const line = Number(target?.closest<HTMLElement>('[data-meo-html-source-line]')?.dataset.meoHtmlSourceLine);
      const anchor = Number.isInteger(line) && line > 0 && line <= view.state.doc.lines
        ? Math.max(currentBlock.from, Math.min(currentBlock.to, view.state.doc.line(line).from)) : undefined;
      event.preventDefault();
      enterHtmlSource(view, currentBlock, anchor, event.clientY);
    });
    this.height.observe(root, view);
    if (contentRoot.querySelector('table')) {
      // The widget is not mounted during toDOM. Its natural table geometry is
      // meaningful only after CodeMirror attaches it; dispose with this widget.
      const layout: HtmlTableLayout = { frame: null, controller: null };
      htmlTableLayouts.set(root, layout);
      layout.frame = requestAnimationFrame(() => {
        layout.frame = null;
        if (htmlTableLayouts.get(root) === layout && root.isConnected) {
          layout.controller = createPreviewTableLayoutController(root.ownerDocument, contentRoot);
        }
      });
    }
    return root;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    const layout = htmlTableLayouts.get(dom);
    if (layout && layout.frame !== null) cancelAnimationFrame(layout.frame);
    layout?.controller?.dispose();
    htmlTableLayouts.delete(dom);
    this.height.destroy(dom);
    disposeImagePresentations(dom);
  }
}

type HtmlDetailsLineNumberColumn = HTMLDivElement & {
  __meoHtmlDetailsLineNumberCleanup?: () => void;
};

const htmlDetailsSemanticLineSelector = [
  'summary',
  'p',
  'blockquote',
  'ul',
  'ol',
  'li',
  'div',
  'table',
  '.meo-md-html-image'
].map((selector) => `[data-meo-html-source-line]:is(${selector})`).join(',');

class HtmlBlockLineNumberMarker extends GutterMarker {
  elementClass: string;

  constructor(private readonly block: RenderableHtmlBlock, private readonly lineNumbers: readonly string[]) {
    super();
    this.elementClass = block.detailsCollapsed === null ? '' : 'meo-md-html-details-line-numbers';
  }

  eq(other: GutterMarker): boolean {
    return other instanceof HtmlBlockLineNumberMarker &&
      other.block.startLine === this.block.startLine &&
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed
      && other.lineNumbers.length === this.lineNumbers.length
      && other.lineNumbers.every((number, index) => number === this.lineNumbers[index]);
  }

  toDOM(view: EditorView): Node {
    if (this.block.detailsCollapsed === null) {
      return document.createTextNode(this.lineNumbers[0]);
    }

    const column = document.createElement('div') as HtmlDetailsLineNumberColumn;
    column.className = 'meo-md-html-details-line-number-column';
    column.__meoHtmlDetailsLineNumberCleanup = mountProjectedLineNumbers(view, column,
      'meo-md-html-details-line-number', () => {
        const root = view.dom.querySelector<HTMLElement>(
          `.meo-md-html-block[data-meo-rendered-block-start-line="${this.block.startLine}"]`);
        const details = root?.querySelector<HTMLDetailsElement>(':scope > .meo-md-html-content > details');
        if (!root || !details) return null;
        const top = column.getBoundingClientRect().top;
        const positions = new Map<number, { line: number; top: number; height: number }>();
        const elements = Array.from(details.querySelectorAll<HTMLElement>(htmlDetailsSemanticLineSelector));
        for (const element of elements) {
          const line = Number(element.dataset.meoHtmlSourceLine), rect = element.getBoundingClientRect();
          if (!Number.isInteger(line) || rect.height < 1 || getComputedStyle(element).display === 'none') continue;
          const key = Math.round(rect.top), previous = positions.get(key);
          if (!previous || line >= previous.line) positions.set(key, { line, top: rect.top - top, height: rect.height });
        }
        const rows = Array.from(positions.values()).sort((left, right) => left.top - right.top)
          .map((row, index) => ({ key: `${row.line}:${index}`, label: this.lineNumbers[row.line - this.block.startLine] ?? '',
            top: row.top, height: row.height }));
        return { rows, elements: [root, ...elements], mutations: [details] };
      });
    return column;
  }

  destroy(dom: Node): void {
    (dom as HtmlDetailsLineNumberColumn).__meoHtmlDetailsLineNumberCleanup?.();
  }
}

const htmlBlockLineNumberMarker = lineNumberWidgetMarker.of((view, widget, block) => {
  if (!(widget instanceof HtmlBlockWidget) || widget.editing || block.height < 1) return null;
  return new HtmlBlockLineNumberMarker(widget.block,
    Array.from({ length: widget.block.endLine - widget.block.startLine + 1 }, (_, index) =>
      formatSourceLineNumber(widget.block.startLine + index, view.state)));
});

class HtmlWarningWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  constructor(readonly source: string) { super(); }
  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const warning = document.createElement('span');
    warning.className = 'meo-md-html-warning';
    const issues = htmlSourceIssues(this.source);
    warning.dataset.tooltip = issues.length ? `${strings.unsupportedHtmlSource}\n${htmlIssueDescription(view, issues)}` : strings.unsupportedHtmlSource;
    warning.dataset.tooltipKind = 'description';
    warning.setAttribute('aria-label', warning.dataset.tooltip ?? '');
    warning.appendChild(createElement(AlertTriangle, { width: 14, height: 14, 'aria-hidden': 'true' }));
    return warning;
  }
}

class InlineHtmlWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType {
    const from = changes.mapPos(this.from, 1);
    const startLine = state.doc.lineAt(from).number;
    return from === this.from && startLine === this.startLine ? this : new InlineHtmlWidget(this.source, from, startLine);
  }
  constructor(readonly source: string, readonly from: number, readonly startLine: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof InlineHtmlWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.source === this.source && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'meo-md-html-inline';
    const content = createSanitizedHtml(
      this.source, true, view.state.facet(uiLanguageFacet), view, this.from, this.startLine
    );
    if (content) wrapper.appendChild(content);
    const firstElement = wrapper.firstElementChild;
    if (firstElement) {
      const tagName = firstElement.tagName.toLowerCase();
      firstElement.classList.add(`meo-md-html-${tagName === 'b' ? 'strong' : tagName}`);
    }
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    disposeImagePresentations(dom);
  }
}

function addInlineHtmlDecorations(
  ranges: any[],
  state: EditorState,
  activeLines: ReadonlySet<number>,
  blockRanges: readonly RenderableHtmlBlock[],
  inlineRanges: Array<{ from: number; to: number }>,
  scope?: { from: number; to: number }
): void {
  const tagStarts = new Set<number>();
  const tagEnds = new Set<number>();
  resolvedSyntaxTree(state).iterate({ ...scope, enter(node) {
    if (node.name === 'HTMLTag') {
      tagStarts.add(node.from);
      tagEnds.add(node.to);
    }
  } });
  const inlineTags = new Set(['strong', 'b', 'em', 'i', 'del', 's', 'mark', 'code', 'span', 'sub', 'sup', 'u', 'a', 'ruby', 'abbr', 'q', 'small', 'img']);
  const overlapsBlock = indexSourceRanges(blockRanges, 'overlaps');
  for (const line of documentLines(state.doc, scope ? state.doc.lineAt(scope.from).number : 1,
    scope ? state.doc.lineAt(scope.to).number : state.doc.lines)) {
    const lineNo = line.number;
    if (activeLines.has(lineNo)) continue;
    if (overlapsBlock(line.from, line.to)) continue;
    for (const fragment of splitHtmlBlockFragments(line.text)) {
      const source = line.text.slice(fragment.from, fragment.to);
      if (!inlineTags.has(getHtmlRootTagName(source) ?? '') || !isSupportedHtmlWithComments(source)) continue;
      const from = line.from + fragment.from;
      const to = line.from + fragment.to;
      // Only actual HTML syntax may replace source; code, escapes, comments and scripts are literal.
      if (!tagStarts.has(from) || !tagEnds.has(to)) continue;
      ranges.push(Decoration.replace({
        widget: new InlineHtmlWidget(source, from, lineNo),
        inclusive: false
      }).range(from, to));
      inlineRanges.push({ from, to });
    }
  }
}

export function addHtmlContentDecorations(
  ranges: any[],
  state: EditorState,
  activeLines: ReadonlySet<number>,
  previousDecorations?: DecorationSet,
  changes?: ChangeDesc,
  inlineRanges: Array<{ from: number; to: number }> = [],
  scope?: { from: number; to: number }
): RenderableHtmlBlock[] {
  const editingRange = getHtmlEditingRange(state);
  const blocks = collectRenderableHtmlBlocks(state, resolvedSyntaxTree(state), scope);
  const addSourceRange = (range: HtmlEditingRange, invalid = false, invisible = false, preview = false): void => {
    const startLine = state.doc.lineAt(Math.min(range.from, state.doc.length));
    const inclusiveEnd = range.to > range.from ? range.to - 1 : range.to;
    const endLine = state.doc.lineAt(Math.max(range.from, Math.min(inclusiveEnd, state.doc.length)));
    for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const classes = [invisible ? 'meo-md-html-invisible-source' : 'meo-md-html-source-range'];
      if (!invisible && lineNumber === startLine.number) classes.push('meo-md-html-source-line', 'meo-md-html-source-range-start');
      if (!invisible && lineNumber === endLine.number) classes.push('meo-md-html-source-range-end');
      if (preview && lineNumber === endLine.number) classes.push('meo-md-html-source-has-preview');
      if (invalid) classes.push('meo-md-html-source-invalid');
      ranges.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
    }
    if (invisible && range.to > range.from) ranges.push(Decoration.mark({ class: 'meo-md-html-invisible-source-text' }).range(range.from, range.to));
    if (!invisible) ranges.push(Decoration.widget({
      widget: new HtmlSourceActionsWidget(state.doc.sliceString(range.from, range.to)), side: 1
    }).range(startLine.to));
  };
  let editingBlockFound = false;
  const previous = blocks.length && previousDecorations && changes
    ? previousDecorations.map(changes)
    : previousDecorations;
  for (const block of blocks) {
    const isEditing = editingRange && editingRange.from === block.from;
    if (isEditing) {
      editingBlockFound = true;
      addSourceRange(editingRange, false, false, block.visible);
      if (block.visible) {
        const followingLine = block.endLine < state.doc.lines ? state.doc.line(block.endLine + 1) : null;
        ranges.push(Decoration.widget({ widget: new HtmlBlockWidget(block, true), block: true, side: followingLine ? -1 : 1 })
          .range(followingLine?.from ?? state.doc.line(block.endLine).to));
      }
      continue;
    }
    if (!block.visible) {
      addSourceRange(block, false, true);
      continue;
    }
    const widget = new HtmlBlockWidget(block);
    previous?.between(block.from, block.to, (_from, _to, decoration) => {
      if (decoration.spec.widget instanceof HtmlBlockWidget) {
        widget.seedHeight(decoration.spec.widget);
      }
    });
    ranges.push(Decoration.replace({
      block: true,
      widget
    }).range(block.from, block.to));
  }
  if (editingRange && !editingBlockFound && (!scope || editingRange.to >= scope.from && editingRange.from <= scope.to)) {
    const source = state.doc.sliceString(editingRange.from, editingRange.to);
    const rendered = renderHtmlMarkdown(source);
    const preview = isSupportedHtmlWithComments(rendered) && htmlHasVisibleContent(rendered);
    addSourceRange(editingRange, true, false, preview);
    if (preview) {
      const endLine = state.doc.lineAt(Math.max(editingRange.from, editingRange.to - 1));
      const followingLine = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : null;
      ranges.push(Decoration.widget({ widget: new HtmlBlockWidget({ ...editingRange, source,
        startLine: state.doc.lineAt(editingRange.from).number, endLine: endLine.number,
        detailsCollapsed: null, visible: true }, true), block: true, side: followingLine ? -1 : 1 })
        .range(followingLine?.from ?? endLine.to));
    }
  }
  const warningLines = new Set<number>();
  resolvedSyntaxTree(state).iterate({
    ...scope,
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'HTMLBlock' && node.name !== 'HTMLTag') return;
      const source = state.doc.sliceString(node.from, node.to);
      if (isSupportedHtmlWithComments(source)) return;
      // A partially typed opening tag is not yet an unsupported HTML fragment.
      if (!scanHtmlTags(source).length && !/^\s*<(?:!|\?)[\s\S]*>/.test(source)) return;
      const line = state.doc.lineAt(node.from);
      if (warningLines.has(line.number)) return;
      warningLines.add(line.number);
      ranges.push(Decoration.widget({
        widget: new HtmlWarningWidget(source),
        side: -1
      }).range(line.to));
    }
  });
  addInlineHtmlDecorations(ranges, state, activeLines, blocks, inlineRanges, scope);
  return blocks;
}

const htmlEscapeKeymap = keymap.of([{
  key: 'Escape',
  run(view) {
    const range = getHtmlEditingRange(view.state);
    if (!range) return false;
    if (view.composing || view.state.selection.ranges.length !== 1
      || !view.state.selection.main.empty && (view.state.selection.main.from < range.from || view.state.selection.main.to > range.to)) return false;
    focusBlockReading(view, { kind: 'html', ...range }, [setHtmlEditingRangeEffect.of(null)]);
    return true;
  }
}]);

function revealHtmlSourceForInput(view: EditorView, target: EventTarget | null): void {
  if (target !== view.contentDOM || getHtmlEditingRange(view.state)) return;
  const selection = view.state.selection.main;
  // Native key/beforeinput guards only need the block containing this caret.
  // Do not parse or discover unrelated suffix blocks on each input state.
  const tree = resolvedSyntaxTreeAt(view.state, selection.to);
  const block = collectRenderableHtmlBlocks(view.state, tree, selection).find((block) => (
    selection.from >= block.from && selection.to <= block.to
  ));
  if (block) enterHtmlSource(view, block);
}

// Reveal before both native input and CodeMirror editing commands. A rendered
// replacement cannot express the saved DOM caret and would redirect native typing.
const htmlSourceInputHandlers = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey && /^[vx]$/i.test(event.key);
    const editingKey = ['Enter', 'Backspace', 'Delete'].includes(event.key) || (
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      (event.key.length === 1 || event.key === 'Process')
    );
    if (shortcut || editingKey) revealHtmlSourceForInput(view, event.target);
    return false;
  },
  beforeinput(event, view) {
    if (/^(insert|delete)/.test(event.inputType)) revealHtmlSourceForInput(view, event.target);
    return false;
  },
  compositionstart(event, view) {
    revealHtmlSourceForInput(view, event.target);
    return false;
  },
  paste(event, view) {
    revealHtmlSourceForInput(view, event.target);
    return false;
  },
  cut(event, view) {
    revealHtmlSourceForInput(view, event.target);
    return false;
  }
}));

export function htmlContentExtensions() {
  return [htmlEditingRangeField, htmlPasteSourceEditing, htmlSourceEditingHistory,
    htmlEscapeKeymap, htmlBlockLineNumberMarker, htmlSourceInputHandlers];
}
