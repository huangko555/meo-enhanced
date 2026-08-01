import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view';
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
import { getDetailsBlocks, toggleCollapsibleSection } from './headingCollapse';

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
  if (cached?.tree === tree) return cached.blocks;
  const blocks: RenderableHtmlBlock[] = [];
  const detailsByAnchor = new Map(
    getDetailsBlocks(state).map((block) => [block.anchorFrom, block] as const)
  );
  tree.iterate({
    enter(node) {
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

function enhanceLinks(root: ParentNode, inline: boolean): void {
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
    const button = createOpenLinkButton(href);
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
      sourceFrom
    );
    const container = widget.toDOM(view);
    container.classList.add('meo-md-html-image');
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
  view?: EditorView,
  sourceFrom = 0
): { fragment: DocumentFragment; imageWidgets: ImageWidget[] } | null {
  if (!isSupportedHtmlSource(source)) return null;
  const template = document.createElement('template');
  template.innerHTML = source;
  sanitizeElementTree(template.content);
  const imageWidgets = view ? enhanceImages(template.content, view, sourceFrom) : [];
  enhanceLinks(template.content, inline);
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
  button.appendChild(createElement(icon, { width: 15, height: 15, 'aria-hidden': 'true' }));
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return button;
}

class HtmlBlockWidget extends WidgetType {
  private imageWidgets: ImageWidget[] = [];

  constructor(readonly block: RenderableHtmlBlock) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof HtmlBlockWidget &&
      other.block.from === this.block.from &&
      other.block.to === this.block.to &&
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'meo-md-html-block';
    root.dataset.meoHtmlFrom = String(this.block.from);
    root.dataset.meoHtmlTo = String(this.block.to);
    const contentRoot = document.createElement('div');
    contentRoot.className = 'meo-md-html-content';
    const content = createSanitizedHtml(this.block.source, false, view, this.block.from);
    if (content) {
      this.imageWidgets = content.imageWidgets;
      const firstElement = content.fragment.firstElementChild as HTMLElement | null;
      const align = normalizeHtmlAlign(firstElement?.getAttribute('align') ?? null);
      if (align) root.style.textAlign = align;
      contentRoot.appendChild(content.fragment);
    }
    root.appendChild(contentRoot);

    const details = contentRoot.querySelector<HTMLDetailsElement>(':scope > details');
    if (details && this.block.detailsCollapsed !== null) {
      details.open = !this.block.detailsCollapsed;
      details.addEventListener('toggle', () => {
        if (details.open === !this.block.detailsCollapsed) return;
        toggleCollapsibleSection(view, this.block.from);
      });
    }

    const button = createHtmlModeButton('meo-md-html-mode-btn meo-md-html-source-toggle', 'Show HTML source', Code2);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      enterHtmlSource(view, this.block);
    });
    root.appendChild(button);
    return root;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(): void {
    for (const widget of this.imageWidgets) widget.destroy();
    this.imageWidgets = [];
  }
}

class HtmlSourceControlWidget extends WidgetType {
  constructor(readonly range: HtmlEditingRange) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof HtmlSourceControlWidget &&
      other.range.from === this.range.from && other.range.to === this.range.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const control = document.createElement('span');
    control.className = 'meo-md-html-source-control';
    const button = createHtmlModeButton('meo-md-html-mode-btn meo-md-html-preview-toggle', 'Show HTML preview', Eye);
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
  toDOM(): HTMLElement {
    const warning = document.createElement('span');
    warning.className = 'meo-md-html-warning';
    warning.title = 'This HTML stays as source because it contains unsupported or invalid markup.';
    warning.setAttribute('aria-label', warning.title);
    warning.appendChild(createElement(AlertTriangle, { width: 14, height: 14, 'aria-hidden': 'true' }));
    return warning;
  }
}

class InlineHtmlWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof InlineHtmlWidget && other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'meo-md-html-inline';
    const content = createSanitizedHtml(this.source, true);
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
  const pattern = /<(strong|b|em|i|del|s|mark|code|span|sub|sup|a)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
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
    enter(node) {
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
  return [htmlEditingRangeField, htmlEscapeKeymap];
}
