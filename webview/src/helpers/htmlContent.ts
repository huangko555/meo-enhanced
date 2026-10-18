import { documentLines } from './documentLines';
import { mapLiveWidgetPositions } from '../editor/liveWidgetPositions';
import { Prec, StateEffect, StateField, type ChangeDesc, type EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  keymap,
  lineNumberWidgetMarker,
  type DecorationSet
} from '@codemirror/view';
import type { SyntaxNodeRef, Tree } from '@lezer/common';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';
import { createElement, AlertTriangle, Code2, Eye } from 'lucide';
import {
  getHtmlRootTagName,
  isSafeHtmlUrl,
  isSupportedHtmlAttribute,
  isSupportedHtmlBlockSource,
  isSupportedHtmlSource,
  normalizeHtmlAlign,
  scanHtmlTags,
  supportedHtmlTags
} from '../../../src/shared/htmlPolicy';
import { createOpenLinkButton } from './linkOpenButton';
import { isPrimaryModifierPointerClick } from './linkNavigation';
import { resolvedSyntaxTree } from './markdownSyntax';
import { indexSourceRanges } from './sourceRangeIndex';
import { getViewportController } from './viewportController';
import { ImageWidget } from './images';
import { getImagePresentationFactory } from '../editor/imagePresentation';
import { getDetailsBlocks, toggleDetailsBlock } from './detailsBlocks';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { estimateBlockWidgetHeight } from '../editor/blockWidgetHeight';
import { formatSourceLineNumber } from '../editor/sourceLineNumbers';
import { mountProjectedLineNumbers } from '../editor/projectedLineNumbers';
import { RenderedBlockPreviewHeight } from './renderedBlockPreview';
import { createPreviewTableLayoutController, type PreviewTableLayoutController } from './previewTableLayout';

export interface RenderableHtmlBlock {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  source: string;
  detailsCollapsed: boolean | null;
}

export interface HtmlEditingRange {
  from: number;
  to: number;
}

const renderableHtmlBlockCache = new WeakMap<EditorState, {
  tree: any;
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

function findHtmlRootEnd(source: string, rootTagName: string): number | null {
  let depth = 0;
  for (const tag of scanHtmlTags(source)) {
    if (tag.name !== rootTagName) continue;
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) return tag.to;
    } else if (!tag.selfClosing) {
      depth += 1;
    }
  }
  return null;
}

export const setHtmlEditingRangeEffect = StateEffect.define<HtmlEditingRange | null>();

export const htmlEditingRangeField = StateField.define<HtmlEditingRange | null>({
  create() {
    return null;
  },
  update(value, transaction) {
    let next = value
      ? { from: transaction.changes.mapPos(value.from, 1), to: transaction.changes.mapPos(value.to, -1) }
      : null;
    let explicitlySet = false;
    for (const effect of transaction.effects) {
      if (effect.is(setHtmlEditingRangeEffect)) {
        next = effect.value;
        explicitlySet = true;
      }
    }
    if (!next || explicitlySet || !transaction.selection) return next;
    const head = transaction.state.selection.main.head;
    return head >= next.from && head <= next.to ? next : null;
  }
});

export function getHtmlEditingRange(state: EditorState): HtmlEditingRange | null {
  return state.field(htmlEditingRangeField, false) ?? null;
}

export function collectRenderableHtmlBlocks(state: EditorState, tree: Tree = resolvedSyntaxTree(state), scope?: { from: number; to: number }): RenderableHtmlBlock[] {
  const cached = scope ? undefined : renderableHtmlBlockCache.get(state);
  if (cached && cached.tree === tree) return cached.blocks;
  const blocks: RenderableHtmlBlock[] = [];
  let detailsByAnchor: Map<number, ReturnType<typeof getDetailsBlocks>[number]> | undefined;
  tree.iterate({
    ...scope,
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'HTMLBlock') return;
      const parsedSource = state.doc.sliceString(node.from, node.to);
      const masked = maskHtmlComments(parsedSource);
      if (!masked) return;
      const rootTagName = getHtmlRootTagName(masked.source);
      if (!rootTagName) return;
      const rootEnd = findHtmlRootEnd(masked.source, rootTagName);
      if (rootEnd === null) return;
      const source = parsedSource.slice(0, rootEnd);
      if (!isSupportedHtmlBlockSource(masked.source.slice(0, rootEnd))) return;
      const to = node.from + rootEnd;
      detailsByAnchor ??= new Map(getDetailsBlocks(state).map((block) => [block.anchorFrom, block] as const));
      const detailsBlock = detailsByAnchor.get(node.from) ?? null;
      blocks.push({
        from: node.from,
        to,
        startLine: state.doc.lineAt(node.from).number,
        endLine: state.doc.lineAt(Math.max(node.from, to - 1)).number,
        source,
        detailsCollapsed: detailsBlock?.collapsed ?? null
      });
    }
  });
  if (!scope) renderableHtmlBlockCache.set(state, { tree, blocks });
  return blocks;
}

function currentHtmlBlock(view: EditorView, source: string, startLine: number): RenderableHtmlBlock | undefined {
  // A retained widget may outlive edits before it; absolute offsets in its original block then go stale.
  return collectRenderableHtmlBlocks(view.state).find((block) => (
    block.startLine === startLine && block.source === source
  ));
}

function sanitizeElementTree(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const tagName = element.tagName.toLowerCase();
    if (!supportedHtmlTags.has(tagName)) {
      element.replaceWith(document.createTextNode(element.outerHTML));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!isSupportedHtmlAttribute(tagName, name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && !isSafeHtmlUrl(attribute.value, name)) {
        element.removeAttribute(attribute.name);
      }
      if (name === 'align') {
        const align = normalizeHtmlAlign(attribute.value);
        if (align) element.setAttribute('align', align);
        else element.removeAttribute(attribute.name);
      }
    }
  }
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
    note.setAttribute('role', 'button');
    note.tabIndex = 0;
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
    note.addEventListener('click', openSource);
    note.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openSource(event);
    });
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
    if (!isSafeHtmlUrl(href, 'href')) continue;
    const linkText = document.createElement('span');
    linkText.className = 'meo-md-link meo-md-html-link';
    linkText.dataset.meoLinkHref = href;
    linkText.dataset.tooltip = anchor.title || anchor.dataset.tooltip || '';
    linkText.dataset.tooltipKind = 'description';
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
): ImageWidget[] {
  const widgets: ImageWidget[] = [];
  const resolveSourceFrom = () => currentHtmlBlock(view, source, sourceStartLine)?.from ?? null;
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const rawSrc = image.getAttribute('src')?.trim() ?? '';
    if (!isSafeHtmlUrl(rawSrc, 'src')) continue;
    const anchor = image.closest<HTMLAnchorElement>('a[href]');
    const linkUrl = anchor?.getAttribute('href')?.trim() ?? '';
    const widget = new ImageWidget(
      rawSrc,
      image.getAttribute('alt') ?? '',
      isSafeHtmlUrl(linkUrl, 'href') ? linkUrl : '',
      sourceFrom,
      getImagePresentationFactory(view.state),
      { uiLanguage: view.state.facet(uiLanguageFacet), sourceFromResolver: resolveSourceFrom }
    );
    const container = widget.toDOM(view);
    container.classList.add('meo-md-html-image');
    if (image.dataset.meoHtmlSourceLine) {
      container.dataset.meoHtmlSourceLine = image.dataset.meoHtmlSourceLine;
    }
    const width = image.getAttribute('width')?.trim() ?? '';
    if (/^\d+(?:\.\d+)?$/.test(width)) {
      container.style.width = `${width}px`;
    }
    const anchorOnlyContainsImage = anchor && Array.from(anchor.childNodes).every((node) => (
      node === image || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    ));
    if (anchorOnlyContainsImage) anchor.replaceWith(container);
    else image.replaceWith(container);
    widgets.push(widget);
  }
  return widgets;
}

function createSanitizedHtml(
  source: string,
  inline: boolean,
  uiLanguage: UiLanguage,
  view?: EditorView,
  sourceFrom = 0,
  sourceStartLine = 1
): { fragment: DocumentFragment; imageWidgets: ImageWidget[] } | null {
  const masked = maskHtmlComments(source);
  if (!masked || !isSupportedHtmlSource(masked.source)) return null;
  const template = document.createElement('template');
  template.innerHTML = source;
  sanitizeElementTree(template.content);
  annotateHtmlSourceLines(template.content, masked.source, sourceStartLine);
  if (view && masked.comments.length) {
    showHtmlComments(template.content, masked.comments, view, source, sourceFrom, inline, sourceStartLine);
  }
  const imageWidgets = view
    ? enhanceImages(template.content, view, sourceFrom, sourceStartLine, source)
    : [];
  enhanceLinks(template.content, inline, uiLanguage);
  return { fragment: template.content, imageWidgets };
}

function preserveHtmlPosition(view: EditorView, mutate: () => void): void {
  const controller = getViewportController(view);
  if (controller) controller.preserveScrollPosition(mutate);
  else mutate();
}

export function enterHtmlSource(view: EditorView, block: HtmlEditingRange, anchor?: number): void {
  const currentSelection = view.state.selection;
  const selection = anchor === undefined && currentSelection.ranges.every((range) => (
    range.from >= block.from && range.to <= block.to
  )) ? currentSelection : { anchor: anchor ?? block.from };
  preserveHtmlPosition(view, () => {
    view.dispatch({
      selection,
      effects: setHtmlEditingRangeEffect.of({ from: block.from, to: block.to }),
      scrollIntoView: false
    });
  });
  view.focus();
}

function exitHtmlSource(view: EditorView, range: HtmlEditingRange): void {
  preserveHtmlPosition(view, () => {
    view.dispatch({ effects: setHtmlEditingRangeEffect.of(null) });
  });
}

function createHtmlModeButton(className: string, label: string, icon: typeof Code2): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.tooltip = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createElement(icon, { width: 18, height: 18, 'aria-hidden': 'true' }));
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return button;
}

type HtmlTableLayout = { frame: number | null; controller: PreviewTableLayoutController | null };
// CodeMirror may retain a widget's DOM while replacing its equal value object.
const htmlTableLayouts = new WeakMap<HTMLElement, HtmlTableLayout>();

class HtmlBlockWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType {
    const from = changes.mapPos(this.block.from, 1), to = changes.mapPos(this.block.to, -1);
    const startLine = state.doc.lineAt(from).number, endLine = state.doc.lineAt(Math.max(from, to - 1)).number;
    if (from === this.block.from && to === this.block.to && startLine === this.block.startLine && endLine === this.block.endLine) return this;
    const next = new HtmlBlockWidget({ ...this.block, from, to, startLine, endLine });
    next.seedHeight(this);
    return next;
  }
  private imageWidgets: ImageWidget[] = [];
  private readonly height: RenderedBlockPreviewHeight;

  constructor(readonly block: RenderableHtmlBlock) {
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
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed;
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const root = document.createElement('div');
    root.className = 'meo-md-html-block';
    root.dataset.meoRenderedBlockKind = 'html';
    root.dataset.meoRenderedBlockStartLine = String(this.block.startLine);
    root.dataset.meoRenderedBlockEndLine = String(this.block.endLine);
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
      this.imageWidgets = content.imageWidgets;
      const firstElement = content.fragment.firstElementChild as HTMLElement | null;
      const align = normalizeHtmlAlign(firstElement?.getAttribute('align') ?? null);
      if (align) root.style.textAlign = align;
      contentRoot.appendChild(content.fragment);
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

    const button = createHtmlModeButton(
      'meo-md-html-mode-btn meo-md-html-source-toggle',
      strings.showHtmlSource,
      Code2
    );
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentBlock = currentHtmlBlock(view, this.block.source, this.block.startLine);
      if (currentBlock) enterHtmlSource(view, currentBlock);
    });
    root.appendChild(button);
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
    for (const widget of this.imageWidgets) widget.destroy();
    this.imageWidgets = [];
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
  if (!(widget instanceof HtmlBlockWidget) || block.height < 1) return null;
  return new HtmlBlockLineNumberMarker(widget.block,
    Array.from({ length: widget.block.endLine - widget.block.startLine + 1 }, (_, index) =>
      formatSourceLineNumber(widget.block.startLine + index, view.state)));
});

class HtmlSourceControlWidget extends UiLanguageSensitiveWidget {
  constructor(readonly range: HtmlEditingRange) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof HtmlSourceControlWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.range.from === this.range.from && other.range.to === this.range.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const control = document.createElement('span');
    control.className = 'meo-md-html-source-control';
    const button = createHtmlModeButton(
      'meo-md-html-mode-btn meo-md-html-preview-toggle',
      strings.showHtmlPreview,
      Eye
    );
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      exitHtmlSource(view, this.range);
    });
    control.appendChild(button);
    return control;
  }
}

class HtmlWarningWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const warning = document.createElement('span');
    warning.className = 'meo-md-html-warning';
    warning.dataset.tooltip = strings.unsupportedHtmlSource;
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
    if (content) wrapper.appendChild(content.fragment);
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
  const pattern = /<(strong|b|em|i|del|s|mark|code|span|sub|sup|u|a)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const overlapsBlock = indexSourceRanges(blockRanges, 'overlaps');
  for (const line of documentLines(state.doc, scope ? state.doc.lineAt(scope.from).number : 1,
    scope ? state.doc.lineAt(scope.to).number : state.doc.lines)) {
    const lineNo = line.number;
    if (activeLines.has(lineNo)) continue;
    if (overlapsBlock(line.from, line.to)) continue;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line.text))) {
      if (!isSupportedHtmlWithComments(match[0])) continue;
      const from = line.from + match.index;
      const to = from + match[0].length;
      // Only actual HTML syntax may replace source; code, escapes, comments and scripts are literal.
      if (!tagStarts.has(from) || !tagEnds.has(to)) continue;
      ranges.push(Decoration.replace({
        widget: new InlineHtmlWidget(match[0], from, lineNo),
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
  const addSourceRange = (range: HtmlEditingRange, invalid = false): void => {
    const startLine = state.doc.lineAt(Math.min(range.from, state.doc.length));
    const inclusiveEnd = range.to > range.from ? range.to - 1 : range.to;
    const endLine = state.doc.lineAt(Math.max(range.from, Math.min(inclusiveEnd, state.doc.length)));
    for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const classes = ['meo-md-html-source-range'];
      if (lineNumber === startLine.number) classes.push('meo-md-html-source-line', 'meo-md-html-source-range-start');
      if (lineNumber === endLine.number) classes.push('meo-md-html-source-range-end');
      if (invalid) classes.push('meo-md-html-source-invalid');
      ranges.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
    }
    ranges.push(Decoration.widget({
      widget: new HtmlSourceControlWidget(range),
      side: 1
    }).range(startLine.from));
  };
  let editingBlockFound = false;
  const previous = blocks.length && previousDecorations && changes
    ? previousDecorations.map(changes)
    : previousDecorations;
  for (const block of blocks) {
    const isEditing = editingRange && editingRange.from === block.from;
    if (isEditing) {
      editingBlockFound = true;
      addSourceRange(editingRange);
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
    addSourceRange(editingRange, true);
  }
  resolvedSyntaxTree(state).iterate({
    ...scope,
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'HTMLBlock') return;
      const source = state.doc.sliceString(node.from, node.to);
      if (isSupportedHtmlWithComments(source)) return;
      ranges.push(Decoration.widget({
        widget: new HtmlWarningWidget(),
        side: -1
      }).range(state.doc.lineAt(node.from).to));
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
    exitHtmlSource(view, range);
    return true;
  }
}]);

function revealHtmlSourceForInput(view: EditorView, target: EventTarget | null): void {
  if (target !== view.contentDOM || getHtmlEditingRange(view.state)) return;
  const selection = view.state.selection.main;
  // Native key/beforeinput guards only need the block containing this caret.
  // Do not parse or discover unrelated suffix blocks on each input state.
  const tree = ensureSyntaxTree(view.state, selection.to, 50) ?? syntaxTree(view.state);
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
  return [htmlEditingRangeField, htmlEscapeKeymap, htmlBlockLineNumberMarker, htmlSourceInputHandlers];
}
