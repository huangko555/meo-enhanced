import { type HighlightStyle, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { MountedTree, NodeProp, Tree } from '@lezer/common';
import { highlightTree } from '@lezer/highlight';
import { isLiveInputDerivedWorkPending } from './liveInputDerivedWork';

/** Keep the original root, ancestors, mounts and absolute offsets while dropping
 * siblings outside this highlight range. Anonymous balancing nodes are normally
 * transparent to highlightTree, so its cursor still visits their preceding
 * descendants even when given a small range near EOF. */
export function syntaxHighlightWindow(tree: Tree, from: number, to: number): Tree {
  if (from <= 0 && to >= tree.length) return tree;
  const { children, positions } = tree;
  const mounted = tree.prop(NodeProp.mounted);
  const offset = mounted?.overlay?.[0]?.from ?? 0;
  const inner = mounted ? syntaxHighlightWindow(mounted.tree, from - offset, to - offset) : undefined;
  const mountChanged = mounted && inner !== mounted.tree;
  if (!children.length && !mountChanged) return tree;
  let low = 0, high = children.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle]! + children[middle]!.length <= from) low = middle + 1;
    else high = middle;
  }
  const first = low;
  high = children.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle]! < to) low = middle + 1;
    else high = middle;
  }
  let changed = !!mountChanged || first !== 0 || low !== children.length;
  const selected = children.slice(first, low);
  for (let index = 0; index < selected.length; index++) {
    const child = selected[index]!;
    if (!(child instanceof Tree)) continue;
    const offset = positions[first + index]!;
    const window = syntaxHighlightWindow(child, from - offset, to - offset);
    if (window !== child) { selected[index] = window; changed = true; }
  }
  if (!changed) return tree;
  const props: ConstructorParameters<typeof Tree>[4] = mountChanged
    ? [...tree.propValues, [NodeProp.mounted, new MountedTree(inner!, mounted.overlay, mounted.parser, mounted.bracketed)]]
    : tree.propValues;
  return new Tree(tree.type, selected, positions.slice(first, low), tree.length, props);
}

/** A palette owned by this surface, using the public Lezer highlighter and
 * CodeMirror's actual visible ranges. Small documents keep the stock extension. */
export function viewportSyntaxHighlighting(style: HighlightStyle): Extension {
  return [style.module ? EditorView.styleModule.of(style.module) : [], ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    private tree: Tree;
    private decoratedTo: number;
    private readonly marks = new Map<string, Decoration>();
    private band: { doc: Text; from: number; to: number } | null = null;
    private bandDirty = false;
    private deferred = false;
    private destroyed = false;
    private repaintQueued = false;

    constructor(view: EditorView) {
      this.tree = syntaxTree(view.state);
      this.decorations = this.build(view);
      this.decoratedTo = view.viewport.to;
      this.measureBand(view);
    }

    update(update: ViewUpdate) {
      const tree = syntaxTree(update.state);
      const to = update.changes.mapPos(this.decoratedTo, 1);
      const placeholder = tree.type.isAnonymous && !tree.type.isTop;
      if (this.band && update.docChanged) this.band = { doc: update.state.doc,
        from: update.changes.mapPos(this.band.from, -1), to: update.changes.mapPos(this.band.to, 1) };
      if (isLiveInputDerivedWorkPending(update.state) || update.view.composing) {
        this.deferred = true;
        this.decorations = this.decorations.map(update.changes);
        this.decoratedTo = to;
      } else if (placeholder && (update.docChanged || !update.viewportChanged)
        || tree.length < update.view.viewport.to && tree.type === this.tree.type && to >= update.view.viewport.to) {
        this.decorations = this.decorations.map(update.changes);
        this.decoratedTo = to;
      } else if (tree !== this.tree || update.viewportChanged || this.deferred || this.bandDirty) {
        this.tree = tree;
        this.decorations = this.build(update.view);
        this.decoratedTo = update.view.viewport.to;
        this.deferred = this.bandDirty = false;
      }
      if (update.docChanged || update.viewportChanged || update.geometryChanged) this.measureBand(update.view);
    }

    private measureBand(view: EditorView) {
      if (this.destroyed) return;
      view.requestMeasure({ key: this,
        read: () => {
          if (this.destroyed) return null;
          const bounds = view.scrollDOM.getBoundingClientRect();
          if (bounds.height <= 0) return null;
          const top = view.documentTop, scale = view.scaleY;
          const first = (bounds.top - top) / scale - 80, last = (bounds.bottom - top) / scale + 80;
          const blocks = view.viewportLineBlocks.filter(block => block.bottom >= first && block.top <= last);
          return blocks.length ? { doc: view.state.doc, from: blocks[0]!.from, to: blocks.at(-1)!.to } : null;
        },
        write: band => {
          if (this.destroyed || !band || band.doc !== view.state.doc
            || this.band?.doc === band.doc && this.band.from === band.from && this.band.to === band.to) return;
          this.band = band; this.bandDirty = true;
          if (this.repaintQueued) return;
          this.repaintQueued = true;
          // requestMeasure writes run inside a view update. Repaint after that
          // update, without a state transaction or another consumer refresh.
          queueMicrotask(() => {
            this.repaintQueued = false;
            if (this.destroyed || this.band?.doc !== view.state.doc || !this.bandDirty) return;
            if (isLiveInputDerivedWorkPending(view.state) || view.composing) { this.deferred = true; return; }
            this.tree = syntaxTree(view.state);
            this.decorations = this.build(view);
            this.decoratedTo = view.viewport.to;
            this.deferred = this.bandDirty = false;
            view.update([]);
          });
        }
      });
    }

    onScroll(_event: Event, view: EditorView) { this.measureBand(view); }
    destroy() { this.destroyed = true; }

    private build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const range of view.visibleRanges) {
        const from = Math.max(range.from, this.band?.from ?? range.from);
        const to = Math.min(range.to, this.band?.to ?? range.to);
        if (from >= to) continue;
        highlightTree(syntaxHighlightWindow(this.tree, from, to), style, (start, end, classes) => {
          let mark = this.marks.get(classes);
          if (!mark) { mark = Decoration.mark({ class: classes }); this.marks.set(classes, mark); }
          builder.add(start, end, mark);
        }, from, to);
      }
      return builder.finish();
    }
  }, { decorations: plugin => plugin.decorations,
    eventObservers: { scroll(event, view) { this.onScroll(event, view); } } })];
}
