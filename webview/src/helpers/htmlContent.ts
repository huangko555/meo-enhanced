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
import { markdownStructureIdentity, isCompleteMarkdownStructure } from '../editor/markdownStructure';
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
  supportedHtmlTags, supportedInlineHtmlTags, normalizeHtmlAttribute, isHtmlUrlAttribute
} from '../../../src/shared/htmlPolicy';
import { createHtmlDocumentStyles, collectHtmlDocumentStyles, readHtmlDocumentStyles } from './htmlDocumentStyles';
import { usesBackgroundMarkdownStructure } from '../editor/backgroundMarkdownStructure';
import { resolveHtmlResources } from './htmlResources';
import { rememberHtmlNativeContent, updateHtmlContentDom } from './htmlContentDom';
import { isExternalDocumentPresentation } from '../editor/externalDocumentPresentation';
import { scanHtmlTags, splitHtmlBlockFragments } from '../../../src/foundation/htmlSyntax';
import { renderHtmlMarkdown } from '../../../src/shared/htmlMarkdown';
import { createOpenLinkButton } from './linkOpenButton';
import { isPrimaryModifierPointerClick } from './linkNavigation';
import { currentSyntaxTree, resolvedSyntaxTree, resolvedSyntaxTreeAt } from './markdownSyntax';
import { indexSourceRanges } from './sourceRangeIndex';
import { getViewportController } from './viewportController';
import { ImageWidget, disposeImagePresentations, resolveConfiguredImageSrc } from './images';
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
import { bindWidgetClick, disposeWidgetClick } from '../editor/widgetPointer';

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
  ends: number[];
  styles: string | undefined;
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

function htmlHasVisibleContent(source: string, styled = false): boolean {
  const transparent = (color: string): boolean => color.toLowerCase() === 'transparent'
    || /^#[\da-f]{3}0$/i.test(color) || /^#[\da-f]{6}00$/i.test(color)
    || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?%?\s*\)$/i.test(color)
    || /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
  const hasInk = (color: string, inherited: boolean): boolean =>
    /^(?:inherit|unset|currentcolor)$/i.test(color) ? inherited : !transparent(color);
  type Paint = { visible: boolean; layout: boolean };
  const paint = (node: ChildNode, ink = true, font = true, shown = true,
    inherited: Readonly<Record<string, string>> = {}, direction: 'ltr' | 'rtl' = 'ltr'): Paint => {
    if ('name' in node && ['style', 'script'].includes(node.name)) return { visible: false, layout: false };
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
    const media = ['img', 'hr', 'br', 'table', 'li', 'svg', 'audio', 'video', 'input', 'button', 'select', 'textarea', 'meter', 'progress'].includes(node.name)
      || styled && Boolean(node.attribs.class?.trim());
    const borders = ['top', 'right', 'bottom', 'left'].map(side => {
      const kind = style[`border-${side}-style`]?.toLowerCase() ?? 'none';
      const width = style[`border-${side}-width`] ?? 'medium';
      const layout = kind !== 'none' && kind !== 'hidden' && (/^(?:thin|medium|thick)$/i.test(width) || parseFloat(width) > 0);
      return { layout, visible: layout && hasInk(style[`border-${side}-color`] ?? 'currentcolor', color) };
    });
    const blockBox = !['inline', 'contents', 'none'].includes(display);
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

const openPastedHtmlSourceEffect = StateEffect.define<HtmlEditingRange[]>({
  map: (ranges, changes) => ranges.map(range => ({ from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) }))
    .filter(range => range.to > range.from)
});

type HtmlEditingState = {
  range: HtmlEditingRange | null;
  paste: { inserted: HtmlEditingRange[]; head: number } | null;
};
const restoreHtmlEditingStateEffect = StateEffect.define<HtmlEditingState>({
  map: (value, changes) => ({
    range: value.range && { from: changes.mapPos(value.range.from, -1), to: changes.mapPos(value.range.to, 1) },
    paste: value.paste && { head: changes.mapPos(value.paste.head, 1), inserted: value.paste.inserted.map(range => ({
      from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1)
    })) }
  })
});

function pastedHtmlEditingRange(state: EditorState, inserted: readonly HtmlEditingRange[]): HtmlEditingRange | undefined {
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return;
  const head = state.selection.main.head;
  const block = collectRenderableHtmlBlocks(state).filter(block => block.to <= head
    && !state.doc.sliceString(block.to, head).trim()
    && inserted.some(range => block.to > range.from && block.from < range.to && head <= range.to)).at(-1);
  return block ? { from: block.from, to: block.to } : undefined;
}

export const htmlEditingRangeField = StateField.define<HtmlEditingState>({
  create() {
    return { range: null, paste: null };
  },
  update(value, transaction) {
    if (isExternalDocumentPresentation(transaction)) return { range: null, paste: null };
    const previous = value.range ?? selectedHtmlBlock(transaction.startState);
    let paste = transaction.docChanged || transaction.selection ? null : value.paste;
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
        paste = null;
        explicitlySet = true;
      } else if (effect.is(openPastedHtmlSourceEffect)) {
        paste = { inserted: effect.value, head: transaction.state.selection.main.head };
      } else if (effect.is(restoreHtmlEditingStateEffect)) {
        next = effect.value.range;
        paste = effect.value.paste;
        explicitlySet = true;
      }
    }
    // The accepted parser may arrive after the paste. Retain only this intent
    // in the existing range owner; a newer input/selection retires it.
    if (paste) {
      if (paste.head !== transaction.state.selection.main.head) paste = null;
      else {
        const pasted = pastedHtmlEditingRange(transaction.state, paste.inserted);
        if (pasted) { next = pasted; paste = null; explicitlySet = true; }
        else if (isCompleteMarkdownStructure(resolvedSyntaxTree(transaction.state, 0), transaction.newDoc.length)) paste = null;
      }
    }
    if (!next || explicitlySet || isLivePointerSelectionActive(transaction.state)) return { range: next, paste };
    const pointerReleased = transaction.effects.some(effect => effect.is(setLivePointerSelectionActiveEffect) && !effect.value.active);
    if (!transaction.selection && !pointerReleased) return { range: next, paste };
    const head = transaction.state.selection.main.head;
    return { range: head >= next.from && head <= next.to ? next : null, paste };
  }
});

export function getHtmlEditingRange(state: EditorState): HtmlEditingRange | null {
  if (blockReadingFocusAt(state)?.kind === 'html') return null;
  const editing = state.field(htmlEditingRangeField, false);
  // Parsing can become ready during the same presentation pass. Consume the
  // owned intent immediately so the first HTML widget already opens as source.
  return editing?.range ?? (editing?.paste && editing.paste.head === state.selection.main.head
    ? pastedHtmlEditingRange(state, editing.paste.inserted) : undefined) ?? selectedHtmlBlock(state) ?? null;
}

// Keep the new fragment open in the paste transaction itself, including when
// the native caret lands in trailing blank lines. The next selection/input owns exit.
const htmlPasteSourceEditing = EditorState.transactionExtender.of(transaction => {
  if (!transaction.isUserEvent('input.paste') || !transaction.docChanged) return null;
  const inserted: Array<{ from: number; to: number }> = [];
  transaction.changes.iterChangedRanges((_from, _to, from, to) => {
    if (transaction.newDoc.sliceString(from, to).includes('<')) inserted.push({ from, to });
  });
  // Extenders run before the input-phase effects are installed. Reading state
  // here would compute a provisional parser/presentation and then repeat it.
  return inserted.length ? { effects: openPastedHtmlSourceEffect.of(inserted) } : null;
});

const htmlSourceEditingHistory = invertedEffects.of(transaction => transaction.docChanged
  && transaction.effects.some(effect => effect.is(setHtmlEditingRangeEffect) || effect.is(openPastedHtmlSourceEffect)
    || effect.is(restoreHtmlEditingStateEffect))
  ? [restoreHtmlEditingStateEffect.of({ range: getHtmlEditingRange(transaction.startState),
    paste: transaction.startState.field(htmlEditingRangeField, false)?.paste ?? null })] : []);

export function collectRenderableHtmlBlocks(state: EditorState, tree: Tree = resolvedSyntaxTree(state), scope?: { from: number; to: number }): RenderableHtmlBlock[] {
  const details = getDetailsBlocks(state);
  const styles = readHtmlDocumentStyles(state.doc, tree) ?? (!usesBackgroundMarkdownStructure(state) && isCompleteMarkdownStructure(tree, state.doc.length)
    ? collectHtmlDocumentStyles(state.doc, tree) : undefined);
  const cached = renderableHtmlBlockCache.get(state.doc);
  if (cached && cached.tree === markdownStructureIdentity(tree) && cached.tabSize === state.tabSize
    && cached.details === details && cached.styles === styles) {
    if (!scope) return cached.blocks;
    let low = 0, high = cached.blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cached.ends[middle]! < scope.from) low = middle + 1;
      else high = middle;
    }
    const visible: RenderableHtmlBlock[] = [];
    for (let index = low; index < cached.blocks.length; index++) {
      const block = cached.blocks[index]!;
      if (block.from > scope.to) break;
      if (block.to >= scope.from) visible.push(block);
    }
    return visible;
  }
  const blocks: RenderableHtmlBlock[] = [];
  let detailsByAnchor: Map<number, ReturnType<typeof getDetailsBlocks>[number]> | undefined;
  const nodes: Array<{ from: number; to: number; standalone?: boolean; bridged?: boolean; tags?: string;
    parts?: Array<{ tagFrom: number; sourceFrom: number }> }> = [];
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
  // Balance actual HTML tokens across Markdown paragraphs. The shared renderer
  // keeps the intervening source's CommonMark ownership; tags in fenced/inline
  // code cannot close this source container.
  const groups: typeof nodes = [];
  for (const node of nodes) {
    const previous = groups.at(-1);
    if (previous && !previous.standalone && !node.standalone) {
      const source = previous.tags ?? state.doc.sliceString(previous.from, previous.to);
      const fragments = splitHtmlBlockFragments(source);
      const tail = source.slice(fragments.at(-1)?.to ?? 0);
      const incomplete = !fragments.length || scanHtmlTags(tail).some(tag => !tag.closing && !tag.selfClosing);
      if (incomplete && supportedHtmlTags.has(getHtmlRootTagName(source) ?? '')) {
        const gap = state.doc.sliceString(previous.to, node.from);
        previous.bridged ||= Boolean(gap.trim());
        previous.parts ??= [{ tagFrom: 0, sourceFrom: previous.from }];
        previous.parts.push({ tagFrom: source.length, sourceFrom: node.from });
        previous.tags = source + state.doc.sliceString(node.from, node.to);
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
    let fragments: Array<{ from: number; to: number }>;
    if (node.bridged) {
      // Balance only real HTML syntax nodes, then restore each root's original
      // coordinates. Markdown inside a root stays with it; prose between roots
      // and literal closing tags inside code cannot join independent widgets.
      const parts = node.parts!;
      const sourceOffset = (offset: number, end = false): number => {
        const position = Math.max(0, offset - (end ? 1 : 0));
        let low = 0, high = parts.length - 1;
        while (low <= high) {
          const middle = (low + high) >>> 1;
          if (parts[middle]!.tagFrom <= position) low = middle + 1;
          else high = middle - 1;
        }
        const part = parts[Math.max(0, high)]!;
        return part.sourceFrom - node.from + offset - part.tagFrom;
      };
      fragments = splitHtmlBlockFragments(node.tags ?? '').map(fragment => ({
        from: sourceOffset(fragment.from), to: sourceOffset(fragment.to, true)
      }));
    } else fragments = splitHtmlBlockFragments(masked.source);
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
      const visible = htmlHasVisibleContent(renderHtmlMarkdown(source), Boolean(styles));
      // Inline tags retain ordinary line editing, even when alone in a
      // paragraph. Only an invisible standalone fragment needs a source row.
      if (node.standalone && visible && !supportedHtmlBlockTags.has(getHtmlRootTagName(source) ?? '')) continue;
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
  if (!scope) {
    let maximum = 0;
    const ends = blocks.map(block => maximum = Math.max(maximum, block.to));
    renderableHtmlBlockCache.set(state.doc, { tree: markdownStructureIdentity(tree), tabSize: state.tabSize, details, blocks, ends, styles });
  }
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
    if (tagName === 'style') { element.remove(); continue; }
    if (!supportedHtmlTags.has(tagName)) {
      issues.push({ kind: 'tag', name: tagName });
      const shell = (element.cloneNode(false) as Element).outerHTML;
      const close = shell.lastIndexOf('</');
      element.replaceWith(document.createTextNode(close < 0 ? shell : shell.slice(0, close)),
        ...Array.from(element.childNodes), ...(close < 0 ? [] : [document.createTextNode(shell.slice(close))]));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!isSupportedHtmlAttribute(tagName, name)) {
        issues.push({ kind: 'attribute', name: `${tagName}.${name}` });
        element.removeAttribute(attribute.name);
        continue;
      }
      const normalized = normalizeHtmlAttribute(tagName, name, attribute.value);
      if (normalized === null) {
        issues.push({ kind: isHtmlUrlAttribute(name) ? 'url' : 'value', name: `${tagName}.${name}` });
        element.removeAttribute(attribute.name);
        continue;
      }
      if (normalized !== attribute.value) element.setAttribute(attribute.name, normalized);
      if ((name === 'href' || name === 'src') && !isSafeHtmlUrl(attribute.value, name)) {
        issues.push({ kind: 'url', name: `${tagName}.${name}` });
        element.removeAttribute(attribute.name);
      }
      if (name === 'align' && ['p', 'div'].includes(tagName)) {
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

const htmlReadingControls = 'summary, button, a, input, select, textarea, label, audio, video, .meo-md-image';

function prepareHtmlReadingContent(content: HTMLElement, root: HTMLElement): void {
  // A native reading host owns its DOM selection independently of CodeMirror's
  // suspended source caret. Inline noneditable widgets otherwise act as atoms
  // in Chromium. Input stays read-only and is never serialized into Markdown.
  content.contentEditable = 'true';
  content.tabIndex = -1;
  root.tabIndex = -1;
  content.setAttribute('role', 'document');
  const preventReadingInput = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select')) return;
    event.preventDefault();
    // Chromium's composition input is noncancelable. Leave its editing host
    // before it can insert composition text into this read-only presentation.
    if (event.type === 'compositionstart') {
      content.contentEditable = 'false';
      root.focus({ preventScroll: true });
    }
  };
  content.addEventListener('beforeinput', preventReadingInput);
  content.addEventListener('compositionstart', preventReadingInput);
  content.addEventListener('pointerdown', event => {
    if (event.button === 0 && !root.classList.contains('meo-md-html-live-result')) content.contentEditable = 'true';
  });
  root.addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.key !== 'Enter' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
      || target?.closest(htmlReadingControls)) return;
    event.preventDefault();
    event.stopPropagation();
    root.click();
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
    bindWidgetClick(note, openSource);
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
    const linkText = anchor;
    linkText.classList.add('meo-md-link', 'meo-md-html-link');
    linkText.draggable = false;
    linkText.dataset.meoLinkHref = href;
    linkText.dataset.tooltip = anchor.title || anchor.dataset.tooltip || '';
    linkText.dataset.tooltipKind = 'description';
    for (const name of ['id', 'title', 'style', 'hidden', 'lang', 'dir']) {
      if (anchor.hasAttribute(name)) linkText.setAttribute(name, anchor.getAttribute(name)!);
    }
    linkText.addEventListener('pointerdown', (event) => {
      if (event.button === 0 && isPrimaryModifierPointerClick(event)) {
        // Native selection can unmount inline HTML before the click arrives.
        event.preventDefault();
      }
    });
    linkText.addEventListener('click', (event) => {
      event.preventDefault();
      if (!isPrimaryModifierPointerClick(event)) return;
      const currentHref = linkText.dataset.meoLinkHref;
      if (currentHref && isSafeHtmlUrl(currentHref, 'href')) {
        linkText.dispatchEvent(new CustomEvent('meo-open-link', { bubbles: true, detail: { href: currentHref } }));
      }
    });
    const button = createOpenLinkButton(href, uiLanguage);
    button.classList.add(inline ? 'meo-md-html-inline-link-button' : 'meo-md-html-link-button');
    anchor.after(button);
  }
}

function enhanceImages(
  root: ParentNode, view: EditorView, sourceFrom: number, sourceStartLine: number, source: string
): void {
  const resolveSourceFrom = () => currentHtmlBlock(view, source, sourceStartLine)?.from ?? null;
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    if (image.closest('picture') || image.hasAttribute('srcset')) continue;
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
    const displayedImage = container.querySelector('img');
    if (displayedImage) for (const attribute of Array.from(image.attributes)) {
      if (attribute.name === 'class') displayedImage.classList.add(...image.classList);
      else if (['title', 'loading', 'decoding'].includes(attribute.name) || /^(?:aria|data)-/.test(attribute.name)) displayedImage.setAttribute(attribute.name, attribute.value);
    }
    for (const name of ['id', 'hidden', 'lang', 'dir', 'class']) {
      if (image.hasAttribute(name)) {
        if (name === 'class') container.classList.add(...image.classList);
        else container.setAttribute(name, image.getAttribute(name)!);
      }
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
  // Color inheritance depends on authored HTML, not the virtual editor's
  // changing inline styles. A [style] ancestor selector invalidates the entire
  // reading viewport whenever CodeMirror adjusts its virtual padding.
  for (const element of template.content.querySelectorAll('[style], [data-meo-html-styled]')) {
    element.toggleAttribute('data-meo-html-styled', element.hasAttribute('style'));
  }
  rememberHtmlNativeContent(template.content);
  annotateHtmlSourceLines(template.content, masked.source, sourceStartLine);
  if (view && masked.comments.length) {
    showHtmlComments(template.content, masked.comments, view, source, sourceFrom, inline, sourceStartLine);
  }
  if (view) enhanceImages(template.content, view, sourceFrom, sourceStartLine, source);
  if (view) for (const element of template.content.querySelectorAll<HTMLElement>('audio,video,track,source,img[srcset],picture img')) {
    for (const name of ['src', 'poster', 'srcset']) if (element.hasAttribute(name)) {
      element.setAttribute(`data-meo-html-${name}`, element.getAttribute(name)!);
      element.removeAttribute(name);
    }
  }
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

// CodeMirror may retain a widget's DOM while replacing its equal value object.
const htmlTableLayouts = new WeakMap<HTMLElement, PreviewTableLayoutController>();
const htmlResourceControllers = new WeakMap<HTMLElement, AbortController>();
const htmlBlockWidgets = new WeakMap<HTMLElement, HtmlBlockWidget>();
const boundHtmlDetails = new WeakSet<HTMLDetailsElement>();

function attachHtmlResources(root: HTMLElement): void {
  let controller = htmlResourceControllers.get(root);
  if (!controller) {
    controller = new AbortController();
    htmlResourceControllers.set(root, controller);
    root.addEventListener('submit', event => event.preventDefault(), { signal: controller.signal });
  }
  const signal = controller.signal;
  resolveHtmlResources(root, { signal,
    resolve: resolveConfiguredImageSrc,
    commit: apply => { if (!signal.aborted && root.isConnected) apply(); } });
}

function disposeHtmlResources(root: HTMLElement): void {
  htmlResourceControllers.get(root)?.abort();
  htmlResourceControllers.delete(root);
  for (const media of root.querySelectorAll<HTMLMediaElement>('audio,video')) {
    media.pause(); media.removeAttribute('src');
    for (const source of media.querySelectorAll('source[src],track[src]')) source.removeAttribute('src');
    media.load();
  }
}

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

  private prepareDetails(contentRoot: ParentNode, root: HTMLElement, view: EditorView): void {
    const details = contentRoot.querySelector<HTMLDetailsElement>(':scope > details');
    const summary = details?.querySelector<HTMLElement>(':scope > summary');
    if (summary && !summary.querySelector(':scope > .meo-md-details-summary-label')) {
      const label = document.createElement('span'); label.className = 'meo-md-details-summary-label';
      label.append(...Array.from(summary.childNodes));
      const icon = document.createElement('span'); icon.className = 'meo-md-details-summary-icon';
      icon.setAttribute('aria-hidden', 'true'); summary.append(icon, label);
    }
    if (details && this.block.detailsCollapsed !== null) {
      details.open = !this.block.detailsCollapsed;
      if (boundHtmlDetails.has(details)) return;
      boundHtmlDetails.add(details);
      details.addEventListener('toggle', () => {
        if (!details.isConnected || !root.contains(details)) return;
        const widget = htmlBlockWidgets.get(root);
        if (!widget) return;
        const currentBlock = currentHtmlBlock(view, widget.block.source, widget.block.startLine);
        if (!currentBlock) return;
        const collapsed = getDetailsBlocks(view.state).find(block => block.anchorFrom === currentBlock.from)?.collapsed;
        if (collapsed !== undefined && details.open !== !collapsed) toggleDetailsBlock(view, currentBlock.from);
      });
    }
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'meo-md-html-block';
    htmlBlockWidgets.set(root, this);
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
    prepareHtmlReadingContent(contentRoot, root);
    contentRoot.contentEditable = this.editing ? 'false' : 'true';
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
    attachHtmlResources(root);

    this.prepareDetails(contentRoot, root, view);

    // Wait until pointerup/click so native dragging can select rendered text.
    // Interactive HTML keeps its own reading action and never opens source.
    root.addEventListener('pointerdown', event => {
      if (event.button === 0 && htmlBlockWidgets.get(root)?.editing) event.preventDefault();
    });
    bindWidgetClick(root, event => {
      const target = event.target instanceof Element ? event.target : null;
      const widget = htmlBlockWidgets.get(root)!;
      if (widget.editing
        || target?.closest(htmlReadingControls + ', .meo-md-html-comment')) return;
      const currentBlock = currentHtmlBlock(view, widget.block.source, widget.block.startLine);
      if (!currentBlock) return;
      const line = Number(target?.closest<HTMLElement>('[data-meo-html-source-line]')?.dataset.meoHtmlSourceLine);
      const anchor = Number.isInteger(line) && line > 0 && line <= view.state.doc.lines
        ? Math.max(currentBlock.from, Math.min(currentBlock.to, view.state.doc.line(line).from)) : undefined;
      event.preventDefault();
      enterHtmlSource(view, currentBlock, anchor, event.clientY);
    });
    const hasTable = contentRoot.querySelector('table') !== null;
    // toDOM runs before attachment, and a deferred update can already be inside
    // a frame callback. Use the existing size observation to fit before paint,
    // rather than expose native auto-layout until another animation frame.
    this.height.observe(root, view, hasTable ? () => {
      htmlTableLayouts.set(root, createPreviewTableLayoutController(root.ownerDocument, contentRoot));
    } : undefined);
    return root;
  }

  updateDOM(root: HTMLElement, view: EditorView): boolean {
    const previous = htmlBlockWidgets.get(root);
    if (!previous || !this.hasSameUiLanguageEpoch(previous)) return false;
    htmlBlockWidgets.set(root, this);
    root.dataset.meoRenderedBlockStartLine = String(this.block.startLine);
    root.dataset.meoRenderedBlockEndLine = String(this.block.endLine);
    root.classList.toggle('meo-md-html-live-result', this.editing);
    let label = root.querySelector<HTMLElement>(':scope > .meo-md-html-result-status');
    if (this.editing && !label) {
      label = root.ownerDocument.createElement('span'); label.className = 'meo-md-html-result-status';
      label.textContent = getUiStrings(view.state.facet(uiLanguageFacet)).preview; root.prepend(label);
    } else if (!this.editing) label?.remove();
    const current = root.querySelector<HTMLElement>(':scope > .meo-md-html-content')!;
    current.contentEditable = this.editing ? 'false' : 'true';
    if (previous.block.source !== this.block.source) {
      const next = root.ownerDocument.createElement('div');
      const content = createSanitizedHtml(this.block.source, false, view.state.facet(uiLanguageFacet), view, this.block.from, this.block.startLine);
      if (content) next.append(content);
      this.prepareDetails(next, root, view);
      updateHtmlContentDom(current, next, element => {
        disposeWidgetClick(element);
        if (element.classList.contains('meo-md-image')) disposeImagePresentations(element);
        if (element instanceof HTMLMediaElement) { element.pause(); element.removeAttribute('src'); element.load(); }
      });
      const first = current.firstElementChild;
      root.style.textAlign = normalizeHtmlAlign(first?.getAttribute('align') ?? null) ?? '';
      attachHtmlResources(root);
    } else if (previous.block.startLine !== this.block.startLine) {
      const delta = this.block.startLine - previous.block.startLine;
      for (const element of current.querySelectorAll<HTMLElement>('[data-meo-html-source-line]')) {
        element.dataset.meoHtmlSourceLine = String(Number(element.dataset.meoHtmlSourceLine) + delta);
      }
    }
    this.prepareDetails(current, root, view);
    const details = current.querySelector<HTMLDetailsElement>(':scope > details');
    if (details && this.block.detailsCollapsed !== null) details.open = !this.block.detailsCollapsed;
    this.height.observe(root, view, () => {
      const layout = htmlTableLayouts.get(root);
      if (layout) layout.refresh();
      else if (current.querySelector('table')) htmlTableLayouts.set(root, createPreviewTableLayoutController(root.ownerDocument, current));
    });
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    disposeWidgetClick(dom);
    for (const note of dom.querySelectorAll<HTMLElement>('.meo-md-html-comment')) disposeWidgetClick(note);
    htmlTableLayouts.get(dom)?.dispose();
    htmlTableLayouts.delete(dom);
    htmlBlockWidgets.delete(dom);
    this.height.destroy(dom);
    disposeHtmlResources(dom);
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
    const contentRoot = document.createElement('span');
    contentRoot.className = 'meo-md-html-content';
    prepareHtmlReadingContent(contentRoot, wrapper);
    const content = createSanitizedHtml(
      this.source, true, view.state.facet(uiLanguageFacet), view, this.from, this.startLine
    );
    if (content) contentRoot.appendChild(content);
    wrapper.appendChild(contentRoot);
    attachHtmlResources(wrapper);
    const firstElement = contentRoot.firstElementChild;
    if (firstElement) {
      const tagName = firstElement.tagName.toLowerCase();
      firstElement.classList.add(`meo-md-html-${tagName === 'b' ? 'strong' : tagName}`);
    }
    bindWidgetClick(wrapper, event => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(htmlReadingControls + ', .meo-md-html-comment')) return;
      event.preventDefault();
      view.focus();
      view.dispatch({ selection: { anchor: this.from } });
    });
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    disposeWidgetClick(dom);
    for (const note of dom.querySelectorAll<HTMLElement>('.meo-md-html-comment')) disposeWidgetClick(note);
    disposeHtmlResources(dom);
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
  const inlineTags = supportedInlineHtmlTags;
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
    htmlEscapeKeymap, htmlBlockLineNumberMarker, htmlSourceInputHandlers,
    createHtmlDocumentStyles(resolvedSyntaxTree, usesBackgroundMarkdownStructure)];
}
