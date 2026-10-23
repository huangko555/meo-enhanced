import type { EditorState, Range, Text } from '@codemirror/state';
import { Decoration, type DecorationSet, type WidgetType } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { getLivePresentationBand, createLiveViewportPlaceholder } from './liveViewportPresentation';
import { getLiveRenderedBlocks, type LiveRenderedBlock } from './liveRenderedBlocks';
import { getDetailsBlocks } from './detailsBlocks';
import { getMermaidBlockMode } from './mermaidEditing';
import { isDisplayMathEditing } from './displayMathEditing';
import { hasRenderedBlockPreview } from './renderedBlockPreview';

type Bounds = { from: number; to: number };
type Scope = Bounds & { fromLine: number; toLine: number };
type Block = Bounds & { block: LiveRenderedBlock };
const sourceBounds = new WeakMap<Text, Map<string, Bounds>>();
const widgetSources = new WeakMap<WidgetType, Bounds & { doc: Text; preview: boolean }>();

function blockBounds(state: EditorState, block: LiveRenderedBlock): Bounds {
  let cache = sourceBounds.get(state.doc);
  if (!cache) { cache = new Map(); sourceBounds.set(state.doc, cache); }
  const key = `${block.startLine}:${block.endLine}`;
  let bounds = cache.get(key);
  if (!bounds) {
    bounds = { from: state.doc.line(block.startLine).from, to: state.doc.line(block.endLine).to };
    cache.set(key, bounds);
  }
  return bounds;
}

/** Complete source context owns semantic blocks; the current window owns marks
 * and widget construction. Offscreen rich roots retain only source and height. */
export function livePresentationWindow(state: EditorState, tree: Tree) {
  const band = getLivePresentationBand(state);
  if (!band) return null;
  const blocks: Block[] = getLiveRenderedBlocks(state, { includeSelectedMath: true, tree })
    .map(block => ({ block, ...blockBounds(state, block) }))
    .sort((left, right) => left.from - right.from || right.to - left.to);
  const roots: Block[] = [];
  for (const block of blocks) {
    if (roots.at(-1) && block.to <= roots.at(-1)!.to) continue;
    roots.push(block);
  }
  let from = band.from, to = band.to;
  const includeRoot = (position: number, side: -1 | 1) => {
    let node = tree.resolveInner(position, side);
    while (node.parent && node.parent.name !== 'Document') node = node.parent;
    // A pending background parse is one anonymous, full-length placeholder.
    // Only actual Document children prove a semantic root to expand around.
    if (node.parent?.name === 'Document') { from = Math.min(from, node.from); to = Math.max(to, node.to); }
  };
  const details = getDetailsBlocks(state, tree);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const oldFrom = from, oldTo = to;
    includeRoot(from, 1); includeRoot(to, -1);
    for (const block of roots) if (block.from < to && block.to > from) {
      from = Math.min(from, block.from); to = Math.max(to, block.to);
    }
    for (const block of details) if (block.sectionFrom < to && block.sectionTo > from) {
      from = Math.min(from, block.sectionFrom); to = Math.max(to, block.sectionTo);
    }
    if (from === oldFrom && to === oldTo) break;
  }
  const first = state.doc.lineAt(from), last = state.doc.lineAt(to);
  const scope: Scope = { from: first.from, to: last.to, fromLine: first.number, toLine: last.number };
  const intersects = (start: number, end: number) => start <= scope.to && end >= scope.from;
  return {
    scope,
    project(ranges: readonly Range<Decoration>[], previous?: DecorationSet): Range<Decoration>[] {
      const projected = ranges.filter(range => intersects(range.from, range.to));
      const remember = (range: Range<Decoration>) => {
        const widget = range.value.spec.widget as WidgetType | undefined;
        if (widget) widgetSources.set(widget, { from: range.from, to: range.to, doc: state.doc,
          preview: hasRenderedBlockPreview(widget) });
      };
      for (const range of projected) remember(range);
      const previousWidgets = new Map<string, WidgetType>();
      if (previous) for (const cursor = previous.iter(); cursor.value; cursor.next()) {
        if (cursor.value.spec.widget) previousWidgets.set(`${cursor.from}:${cursor.to}`, cursor.value.spec.widget);
      }
      for (const { block, from, to } of roots) {
        if (intersects(from, to)) continue;
        let preview = block.kind === 'math' || block.kind === 'mermaid';
        let height = block.kind === 'table' ? Math.max(1, block.endLine - block.startLine) * 34 + 12
          : block.kind === 'html' ? 100 : block.kind === 'mermaid' ? 180 : 64;
        if (block.kind === 'math' && isDisplayMathEditing(state, block.startLine, block.endLine)) {
          preview = false; height += (block.endLine - block.startLine + 1) * 24 + 49;
        }
        if (block.kind === 'mermaid' && block.endLine > block.startLine + 1) {
          const mode = getMermaidBlockMode(state, from, to).decision.effectiveMode;
          if (mode !== 'preview') { preview = false; height = (block.endLine - block.startLine + 1) * 24 + 49; }
        }
        const previousWidget = previousWidgets.get(`${from}:${to}`);
        const source = previousWidget && widgetSources.get(previousWidget);
        const unchanged = source && source.preview === preview && (source.doc === state.doc && source.from === from && source.to === to
          || source.doc.slice(source.from, source.to).eq(state.doc.slice(from, to)));
        const range = Decoration.replace({ block: true,
          widget: createLiveViewportPlaceholder(height, unchanged ? previousWidget : undefined, preview) }).range(from, to);
        projected.push(range); remember(range);
      }
      return projected;
    }
  };
}
