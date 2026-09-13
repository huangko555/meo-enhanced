import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  keymap,
  lineNumberWidgetMarker
} from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';
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
import { resolvedSyntaxTree } from './markdownSyntax';
import { getViewportController } from './viewportController';
import { ImageWidget } from './images';
import { getImagePresentationFactory } from '../editor/imagePresentation';
import { getDetailsBlocks, toggleDetailsBlock } from './detailsBlocks';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { estimateBlockWidgetHeight } from '../editor/blockWidgetHeight';

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

export function collectRenderableHtmlBlocks(state: EditorState): RenderableHtmlBlock[] {
  const tree = resolvedSyntaxTree(state);
  const cached = renderableHtmlBlockCache.get(state);
  if (cached && cached.tree === tree) return cached.blocks;
  const blocks: RenderableHtmlBlock[] = [];
  const detailsByAnchor = new Map(
    getDetailsBlocks(state).map((block) => [block.anchorFrom, block] as const)
  );
  tree.iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'HTMLBlock') return;
      const parsedSource = state.doc.sliceString(node.from, node.to);
      const rootTagName = getHtmlRootTagName(parsedSource);
      if (!rootTagName) return;
      const rootEnd = findHtmlRootEnd(parsedSource, rootTagName);
      if (rootEnd === null) return;
      const source = parsedSource.slice(0, rootEnd);
      if (!isSupportedHtmlBlockSource(source)) return;
      const to = node.from + rootEnd;
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
  renderableHtmlBlockCache.set(state, { tree, blocks });
  return blocks;
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

function enhanceLinks(root: ParentNode, inline: boolean, uiLanguage: UiLanguage): void {
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (!isSafeHtmlUrl(href, 'href')) continue;
    const linkText = document.createElement('span');
    linkText.className = 'meo-md-link meo-md-html-link';
    linkText.dataset.meoLinkHref = href;
    linkText.title = anchor.title;
    linkText.append(...Array.from(anchor.childNodes));
    linkText.addEventListener('click', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      linkText.dispatchEvent(new CustomEvent('meo-open-link', { bubbles: true, detail: { href } }));
    });
    const button = createOpenLinkButton(href, uiLanguage);
    button.classList.add(inline ? 'meo-md-html-inline-link-button' : 'meo-md-html-link-button');
    anchor.replaceWith(linkText, button);
  }
}

function enhanceImages(root: ParentNode, view: EditorView, sourceFrom: number): ImageWidget[] {
  const widgets: ImageWidget[] = [];
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
      { uiLanguage: view.state.facet(uiLanguageFacet) }
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
  if (!isSupportedHtmlSource(source)) return null;
  const template = document.createElement('template');
  template.innerHTML = source;
  sanitizeElementTree(template.content);
  annotateHtmlSourceLines(template.content, source, sourceStartLine);
  const imageWidgets = view ? enhanceImages(template.content, view, sourceFrom) : [];
  enhanceLinks(template.content, inline, uiLanguage);
  return { fragment: template.content, imageWidgets };
}

function preserveHtmlPosition(view: EditorView, mutate: () => void): void {
  const controller = getViewportController(view);
  if (controller) controller.preserveScrollPosition(mutate);
  else mutate();
}

export function enterHtmlSource(view: EditorView, block: HtmlEditingRange): void {
  preserveHtmlPosition(view, () => {
    view.dispatch({
      selection: { anchor: block.from },
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
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createElement(icon, { width: 18, height: 18, 'aria-hidden': 'true' }));
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return button;
}

class HtmlBlockWidget extends UiLanguageSensitiveWidget {
  private imageWidgets: ImageWidget[] = [];
  private heightObserver: ResizeObserver | null = null;
  private measuredHeight = -1;

  constructor(readonly block: RenderableHtmlBlock) {
    super();
  }

  get estimatedHeight(): number {
    return estimateBlockWidgetHeight({
      kind: 'html-block',
      source: this.block.source,
      collapsed: this.block.detailsCollapsed === true,
      measuredHeight: this.measuredHeight
    });
  }

  eq(other: WidgetType): boolean {
    return other instanceof HtmlBlockWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.block.from === this.block.from &&
      other.block.to === this.block.to &&
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed;
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const root = document.createElement('div');
    root.className = 'meo-md-html-block';
    root.dataset.meoHtmlFrom = String(this.block.from);
    root.dataset.meoHtmlTo = String(this.block.to);
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
        const collapsed = getDetailsBlocks(view.state)
          .find((block) => block.anchorFrom === this.block.from)?.collapsed;
        if (collapsed === undefined || details.open === !collapsed) return;
        toggleDetailsBlock(view, this.block.from);
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
      enterHtmlSource(view, this.block);
    });
    root.appendChild(button);
    if (typeof ResizeObserver !== 'undefined') {
      this.heightObserver = new ResizeObserver(() => {
        const height = root.getBoundingClientRect().height;
        if (height > 0) this.measuredHeight = height;
      });
      this.heightObserver.observe(root);
    }
    return root;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(): void {
    this.heightObserver?.disconnect();
    this.heightObserver = null;
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

  constructor(private readonly block: RenderableHtmlBlock) {
    super();
    this.elementClass = block.detailsCollapsed === null ? '' : 'meo-md-html-details-line-numbers';
  }

  eq(other: GutterMarker): boolean {
    return other instanceof HtmlBlockLineNumberMarker &&
      other.block.from === this.block.from &&
      other.block.startLine === this.block.startLine &&
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed;
  }

  toDOM(view: EditorView): Node {
    if (this.block.detailsCollapsed === null) {
      return document.createTextNode(String(this.block.startLine));
    }

    const column = document.createElement('div') as HtmlDetailsLineNumberColumn;
    column.className = 'meo-md-html-details-line-number-column';
    let animationFrame = 0;
    let observer: ResizeObserver | null = null;
    let signature = '';

    const sync = (): boolean => {
      const outerMarker = column.closest<HTMLElement>('.cm-gutterElement');
      const root = view.dom.querySelector<HTMLElement>(
        `.meo-md-html-block[data-meo-html-from="${this.block.from}"]`
      );
      const details = root?.querySelector<HTMLDetailsElement>(':scope > .meo-md-html-content > details');
      if (!outerMarker || !root || !details) return false;

      const outerRect = outerMarker.getBoundingClientRect();
      const positions = new Map<number, { line: number; top: number }>();
      for (const element of Array.from(details.querySelectorAll<HTMLElement>(htmlDetailsSemanticLineSelector))) {
        const line = Number(element.dataset.meoHtmlSourceLine);
        const rect = element.getBoundingClientRect();
        if (!Number.isInteger(line) || rect.height < 1 || getComputedStyle(element).display === 'none') continue;
        const top = rect.top - outerRect.top;
        const key = Math.round(top);
        const previous = positions.get(key);
        if (!previous || line >= previous.line) positions.set(key, { line, top });
      }
      const rows = Array.from(positions.values()).sort((left, right) => left.top - right.top);
      const nextSignature = rows.map((row) => `${row.line}:${row.top.toFixed(2)}`).join('|');
      if (nextSignature !== signature) {
        signature = nextSignature;
        column.replaceChildren(...rows.map((row) => {
          const marker = document.createElement('span');
          marker.className = 'meo-md-html-details-line-number';
          marker.textContent = String(row.line);
          marker.style.top = `${row.top}px`;
          return marker;
        }));
      }
      if (!observer && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => sync());
        observer.observe(root);
      }
      return true;
    };
    const settle = (attemptsLeft: number): void => {
      if (sync() || attemptsLeft <= 1) return;
      animationFrame = window.requestAnimationFrame(() => settle(attemptsLeft - 1));
    };
    queueMicrotask(() => settle(4));
    column.__meoHtmlDetailsLineNumberCleanup = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      observer = null;
    };
    return column;
  }

  destroy(dom: Node): void {
    (dom as HtmlDetailsLineNumberColumn).__meoHtmlDetailsLineNumberCleanup?.();
  }
}

const htmlBlockLineNumberMarker = lineNumberWidgetMarker.of((view, widget, block) => {
  if (!(widget instanceof HtmlBlockWidget) || block.height < 1) return null;
  return new HtmlBlockLineNumberMarker(widget.block);
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
  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const warning = document.createElement('span');
    warning.className = 'meo-md-html-warning';
    warning.title = strings.unsupportedHtmlSource;
    warning.setAttribute('aria-label', warning.title);
    warning.appendChild(createElement(AlertTriangle, { width: 14, height: 14, 'aria-hidden': 'true' }));
    return warning;
  }
}

class InlineHtmlWidget extends UiLanguageSensitiveWidget {
  constructor(readonly source: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof InlineHtmlWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.source === this.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'meo-md-html-inline';
    const content = createSanitizedHtml(this.source, true, view.state.facet(uiLanguageFacet));
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
  blockRanges: readonly RenderableHtmlBlock[]
): void {
  const pattern = /<(strong|b|em|i|del|s|mark|code|span|sub|sup|u|a)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    if (activeLines.has(lineNo)) continue;
    const line = state.doc.line(lineNo);
    if (blockRanges.some((block) => line.from < block.to && line.to > block.from)) continue;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line.text))) {
      if (!isSupportedHtmlSource(match[0])) continue;
      ranges.push(Decoration.replace({
        widget: new InlineHtmlWidget(match[0]),
        inclusive: false
      }).range(line.from + match.index, line.from + match.index + match[0].length));
    }
  }
}

export function addHtmlContentDecorations(
  ranges: any[],
  state: EditorState,
  activeLines: ReadonlySet<number>
): RenderableHtmlBlock[] {
  const editingRange = getHtmlEditingRange(state);
  const blocks = collectRenderableHtmlBlocks(state);
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
  for (const block of blocks) {
    const isEditing = editingRange && editingRange.from === block.from;
    if (isEditing) {
      editingBlockFound = true;
      addSourceRange(editingRange);
      continue;
    }
    ranges.push(Decoration.replace({
      block: true,
      widget: new HtmlBlockWidget(block)
    }).range(block.from, block.to));
  }
  if (editingRange && !editingBlockFound) {
    addSourceRange(editingRange, true);
  }
  resolvedSyntaxTree(state).iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'HTMLBlock') return;
      const source = state.doc.sliceString(node.from, node.to);
      if (isSupportedHtmlSource(source)) return;
      ranges.push(Decoration.widget({
        widget: new HtmlWarningWidget(),
        side: -1
      }).range(state.doc.lineAt(node.from).to));
    }
  });
  addInlineHtmlDecorations(ranges, state, activeLines, blocks);
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

export function htmlContentExtensions() {
  return [htmlEditingRangeField, htmlEscapeKeymap, htmlBlockLineNumberMarker];
}
