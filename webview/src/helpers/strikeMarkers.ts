import { StateField, RangeSetBuilder, EditorState } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { currentSyntaxTree, syntaxTreeChanged } from './markdownSyntax';

const sourceStrikeMarkerDeco = Decoration.mark({ class: 'meo-md-strike-marker' });

function computeSourceStrikeMarkers(state: EditorState): any {
  const ranges = new RangeSetBuilder<any>();
  const tree = currentSyntaxTree(state);
  tree.iterate({
    enter(node: any) {
      if (node.name !== 'StrikethroughMark') {
        return;
      }
      ranges.add(node.from, node.to, sourceStrikeMarkerDeco);
    }
  });

  return ranges.finish();
}

export const sourceStrikeMarkerField = StateField.define<any>({
  create(state: EditorState) {
    try {
      return computeSourceStrikeMarkers(state);
    } catch {
      return Decoration.none;
    }
  },
  update(markers: any, transaction: any) {
    if (!transaction.docChanged && !syntaxTreeChanged(transaction)) {
      return markers;
    }
    try {
      return computeSourceStrikeMarkers(transaction.state);
    } catch {
      return markers;
    }
  },
  provide: (field: any) => EditorView.decorations.from(field)
});
