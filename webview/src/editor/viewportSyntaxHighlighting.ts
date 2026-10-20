import { type HighlightStyle, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { MountedTree, NodeProp, Tree } from '@lezer/common';
import { highlightTree } from '@lezer/highlight';

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

    constructor(view: EditorView) {
      this.tree = syntaxTree(view.state);
      this.decorations = this.build(view);
      this.decoratedTo = view.viewport.to;
    }

    update(update: ViewUpdate) {
      const tree = syntaxTree(update.state);
      const to = update.changes.mapPos(this.decoratedTo, 1);
      const placeholder = tree.type.isAnonymous && !tree.type.isTop;
      if (placeholder && (update.docChanged || !update.viewportChanged)
        || tree.length < update.view.viewport.to && tree.type === this.tree.type && to >= update.view.viewport.to) {
        this.decorations = this.decorations.map(update.changes);
        this.decoratedTo = to;
      } else if (tree !== this.tree || update.viewportChanged) {
        this.tree = tree;
        this.decorations = this.build(update.view);
        this.decoratedTo = update.view.viewport.to;
      }
    }

    private build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        highlightTree(syntaxHighlightWindow(this.tree, from, to), style, (start, end, classes) => {
          let mark = this.marks.get(classes);
          if (!mark) { mark = Decoration.mark({ class: classes }); this.marks.set(classes, mark); }
          builder.add(start, end, mark);
        }, from, to);
      }
      return builder.finish();
    }
  }, { decorations: plugin => plugin.decorations })];
}
