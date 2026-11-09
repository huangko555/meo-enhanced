import type { EditorState, Range, Text } from '@codemirror/state';
import { Decoration, type DecorationSet, type WidgetType } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { getLivePresentationBand, createLiveViewportPlaceholder, isLiveViewportPlaceholder, restrictLiveWidgetPresentation } from './liveViewportPresentation';
import { getLiveRenderedBlocks, type LiveRenderedBlock } from './liveRenderedBlocks';
import { getDetailsBlocks } from './detailsBlocks';
import { getMermaidBlockMode } from './mermaidEditing';
import { isDisplayMathEditing } from './displayMathEditing';
import { hasRenderedBlockPreview } from './renderedBlockPreview';
import { markdownStructureIdentity } from '../editor/markdownStructure';
import { replaceLivePresentationRanges, updateLivePresentationRanges } from '../editor/liveWidgetPositions';

type Bounds = { from: number; to: number };
type Scope = Bounds & { fromLine: number; toLine: number };
type Block = Bounds & { block: LiveRenderedBlock };
const sourceBounds = new WeakMap<Text, Map<string, Bounds>>();
const widgetSources = new WeakMap<WidgetType, Bounds & { doc: Text; preview: boolean }>();
const blockIndexes = new WeakMap<readonly LiveRenderedBlock[], { doc: Text; roots: Block[]; index: RangeIndex<Block> }>();
const detailsIndexes = new WeakMap<readonly object[], RangeIndex<Bounds>>();
type PresentationWindow = {
  scope: Scope;
  project(ranges: readonly Range<Decoration>[], previous?: DecorationSet): Range<Decoration>[];
  refreshWidgets(decorations: DecorationSet, previous: EditorState,
    build: (scope: Scope) => Range<Decoration>[]): DecorationSet | undefined;
  advance(decorations: DecorationSet, previous: PresentationWindow, previousDecorations: DecorationSet): DecorationSet | undefined;
};
const windowInputs = new WeakMap<PresentationWindow, { doc: Text; tree: Tree; blocks: object; details: object }>();

/** One immutable interval index per accepted source projection. Prefix maxima
 * retain enclosing ranges while binary searches skip unrelated document roots. */
class RangeIndex<T extends Bounds> {
  private readonly ordered: readonly T[];
  private readonly ends: readonly number[];
  constructor(ordered: readonly T[]) {
    this.ordered = ordered;
    let maximum = -Infinity;
    this.ends = this.ordered.map(range => maximum = Math.max(maximum, range.to));
  }
  private first(from: number, touching = false): number {
    let low = 0, high = this.ends.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (touching ? this.ends[middle]! < from : this.ends[middle]! <= from) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  extend(bounds: Bounds): void {
    // Expansion follows the same source-order pass as the full implementation:
    // a later crossing interval can extend the end again in this very pass.
    for (let i = this.first(bounds.from); i < this.ordered.length; i++) {
      const range = this.ordered[i]!;
      if (range.from >= bounds.to) break;
      if (range.to > bounds.from) {
        bounds.from = Math.min(bounds.from, range.from); bounds.to = Math.max(bounds.to, range.to);
      }
    }
  }
  between(from: number, to: number, visit: (range: T) => void, touching = false): void {
    for (let i = this.first(from, touching); i < this.ordered.length; i++) {
      const range = this.ordered[i]!;
      if (touching ? range.from > to : range.from >= to) break;
      if (touching ? range.to >= from : range.to > from) visit(range);
    }
  }
}

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
export function livePresentationWindow(state: EditorState, tree: Tree): PresentationWindow | null {
  const band = getLivePresentationBand(state);
  if (!band) return null;
  const blocks = getLiveRenderedBlocks(state, { includeSelectedMath: true, tree });
  let indexed = blockIndexes.get(blocks);
  if (!indexed || indexed.doc !== state.doc) {
    const ordered = blocks.map(block => ({ block, ...blockBounds(state, block) }))
      .sort((left, right) => left.from - right.from || right.to - left.to);
    const roots: Block[] = [];
    for (const block of ordered) {
      if (roots.at(-1) && block.to <= roots.at(-1)!.to) continue;
      roots.push(block);
    }
    indexed = { doc: state.doc, roots, index: new RangeIndex(roots) };
    blockIndexes.set(blocks, indexed);
  }
  const { roots, index } = indexed;
  let from = band.from, to = band.to;
  const includeRoot = (position: number, side: -1 | 1) => {
    let node = tree.resolveInner(position, side);
    while (node.parent && node.parent.name !== 'Document') node = node.parent;
    // A pending background parse is one anonymous, full-length placeholder.
    // Only actual Document children prove a semantic root to expand around.
    if (node.parent?.name === 'Document') { from = Math.min(from, node.from); to = Math.max(to, node.to); }
  };
  const details = getDetailsBlocks(state, tree);
  let detailsIndex = detailsIndexes.get(details);
  if (!detailsIndex) {
    detailsIndex = new RangeIndex(details.map(block => ({ from: block.sectionFrom, to: block.sectionTo }))
      .sort((a, b) => a.from - b.from || b.to - a.to));
    detailsIndexes.set(details, detailsIndex);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const oldFrom = from, oldTo = to;
    includeRoot(from, 1); includeRoot(to, -1);
    const expanded = { from, to };
    index.extend(expanded); detailsIndex.extend(expanded);
    from = expanded.from; to = expanded.to;
    if (from === oldFrom && to === oldTo) break;
  }
  const first = state.doc.lineAt(from), last = state.doc.lineAt(to);
  const scope: Scope = { from: first.from, to: last.to, fromLine: first.number, toLine: last.number };
  const intersects = (start: number, end: number) => start <= scope.to && end >= scope.from;
  const remember = (range: Range<Decoration>) => {
    const widget = range.value.spec.widget as WidgetType | undefined;
    if (widget) widgetSources.set(widget, { from: range.from, to: range.to, doc: state.doc,
      preview: hasRenderedBlockPreview(widget) });
  };
  const placeholder = ({ block, from, to }: Block, previousWidget?: WidgetType) => {
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
    const source = previousWidget && widgetSources.get(previousWidget);
    const unchanged = source && source.preview === preview && (source.doc === state.doc && source.from === from && source.to === to
      || source.doc.slice(source.from, source.to).eq(state.doc.slice(from, to)));
    const range = Decoration.replace({ block: true,
      widget: createLiveViewportPlaceholder(height, unchanged ? previousWidget : undefined, preview) }).range(from, to);
    remember(range);
    return range;
  };
  const result: PresentationWindow = {
    scope,
    refreshWidgets(decorations, previous, build) {
      const oldBand = getLivePresentationBand(previous);
      if (!oldBand || previous.doc !== state.doc) return;
      const pending: Bounds[] = [];
      decorations.between(band.from, band.to, (from, to, value) => {
        if (!isLiveViewportPlaceholder(value.spec.widget)) return;
        pending.push({ from, to });
      });
      pending.sort((left, right) => left.from - right.from || right.to - left.to);
      const scopes: Scope[] = [];
      for (const range of pending) {
        const accepted = scopes.at(-1);
        if (accepted && range.from >= accepted.from && range.to <= accepted.to) continue;
        let bounds = { ...range }, closed = false;
        // A placeholder owns its source block, not the enclosing list/quote.
        // Reuse the canonical renderer on that closed block without rebuilding
        // every sibling of a retained, potentially document-sized container.
        for (let attempt = 0; attempt < 8; attempt++) {
          const prior = { ...bounds };
          let richBlock = false;
          index.between(bounds.from, bounds.to, block => {
            if (block.from <= bounds.from && block.to >= bounds.to) {
              bounds.from = block.from; bounds.to = block.to; richBlock = true;
            }
          }, true);
          if (!richBlock) for (const [position, side] of [[bounds.from, 1], [bounds.to, bounds.to === bounds.from ? 1 : -1]] as const) {
            let node = tree.resolveInner(position, side);
            if (node.name === 'QuoteMark' || node.name === 'ListMark') continue;
            // HTML's balanced semantic bounds are indexed above. Its raw
            // Markdown node can also own unrelated trailing quoted source.
            while (node.parent && !/^(?:Paragraph|Task|Table|FencedCode|CodeBlock|ATXHeading[1-6]|SetextHeading[12]|HorizontalRule)$/.test(node.name)) node = node.parent;
            if (node.name !== 'Document') { bounds.from = Math.min(bounds.from, node.from); bounds.to = Math.max(bounds.to, node.to); }
          }
          index.extend(bounds); detailsIndex!.extend(bounds);
          decorations.between(bounds.from, bounds.to, (from, to, value) => {
            if (value.spec.widget) { bounds.from = Math.min(bounds.from, from); bounds.to = Math.max(bounds.to, to); }
          });
          bounds = { from: state.doc.lineAt(bounds.from).from, to: state.doc.lineAt(bounds.to).to };
          if (bounds.from === prior.from && bounds.to === prior.to) { closed = true; break; }
        }
        if (!closed || bounds.from < scope.from || bounds.to > scope.to) return;
        scopes.push({ ...bounds, fromLine: state.doc.lineAt(bounds.from).number, toLine: state.doc.lineAt(bounds.to).number });
      }
      scopes.sort((left, right) => left.from - right.from);
      const merged: Scope[] = [];
      for (const part of scopes) {
        const last = merged.at(-1);
        if (last && part.from <= last.to) { last.to = Math.max(last.to, part.to); last.toLine = state.doc.lineAt(last.to).number; }
        else merged.push(part);
      }
      let next = decorations;
      for (const part of merged) {
        // Ancestor marks outside this block remain accepted; the complete
        // source context still supplies references, container and list facts.
        const ranges = build(part).filter(range => range.from >= part.from && range.to <= part.to);
        next = replaceLivePresentationRanges(next, part.from, part.to, ranges);
        for (const range of ranges) remember(range);
      }
      const retired: Range<Decoration>[] = [];
      next.between(oldBand.from, oldBand.to, (from, to, value) => {
        if (value.spec.widget && !isLiveViewportPlaceholder(value.spec.widget)
          && (to < band.from || from > band.to)) retired.push(value.range(from, to));
      });
      if (retired.length) {
        const originals = new Map<Decoration, Set<string>>();
        for (const range of retired) {
          const positions = originals.get(range.value) ?? new Set<string>();
          positions.add(`${range.from}:${range.to}`); originals.set(range.value, positions);
        }
        restrictLiveWidgetPresentation(retired, state);
        for (const range of retired) remember(range);
        next = updateLivePresentationRanges(next, { filterFrom: oldBand.from, filterTo: oldBand.to,
          filter: (from, to, value) => !originals.get(value)?.has(`${from}:${to}`),
          add: retired, sort: true });
      }
      return next;
    },
    project(ranges: readonly Range<Decoration>[], previous?: DecorationSet): Range<Decoration>[] {
      const projected = ranges.filter(range => intersects(range.from, range.to));
      for (const range of projected) remember(range);
      const previousWidgets = new Map<string, WidgetType>();
      if (previous) for (const cursor = previous.iter(); cursor.value; cursor.next()) {
        if (cursor.value.spec.widget) previousWidgets.set(`${cursor.from}:${cursor.to}`, cursor.value.spec.widget);
      }
      for (const { block, from, to } of roots) {
        if (intersects(from, to)) continue;
        const previousWidget = previousWidgets.get(`${from}:${to}`);
        projected.push(placeholder({ block, from, to }, previousWidget));
      }
      return projected;
    },
    advance(decorations, previous, previousDecorations) {
      const input = windowInputs.get(previous);
      if (!input || input.doc !== state.doc || input.tree !== markdownStructureIdentity(tree)
        || input.blocks !== blocks || input.details !== details) return;
      if (scope.from === previous.scope.from && scope.to === previous.scope.to) return decorations;
      const retired: Range<Decoration>[] = [];
      index.between(previous.scope.from, previous.scope.to, root => {
        if (intersects(root.from, root.to)) return;
        let widget: WidgetType | undefined;
        previousDecorations.between(root.from, root.to, (from, to, value) => {
          if (from === root.from && to === root.to && value.spec.widget) widget = value.spec.widget;
        });
        retired.push(placeholder(root, widget));
      }, true);
      // Only the old reading band can contain live presentation to retire.
      // Layered updates retain all distant height points and RangeSet chunks.
      const next = updateLivePresentationRanges(decorations, {
        filterFrom: previous.scope.from, filterTo: previous.scope.to,
        filter: (from, to) => intersects(from, to), add: retired, sort: true
      });
      next.between(scope.from, scope.to, (from, to, value) => remember(value.range(from, to)));
      return next;
    }
  };
  windowInputs.set(result, { doc: state.doc, tree: markdownStructureIdentity(tree), blocks, details });
  return result;
}
