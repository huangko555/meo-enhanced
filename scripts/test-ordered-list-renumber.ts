import { EditorState } from '@codemirror/state';
import { collectOrderedListRenumberChanges, listMarkerData } from '../webview/src/helpers/listMarkers';

const state = EditorState.create({
  doc: '1. First\n2. Second\n3. Third\n  4. Nested first\n  5. Nested second'
});
const nestedMarker = listMarkerData('  4. Nested first');
if (nestedMarker?.indentLevel !== 1) {
  throw new Error(`Expected the indented item to be at level 1, received ${nestedMarker?.indentLevel}`);
}
const changes = collectOrderedListRenumberChanges(state);
const renumbered = state.update({ changes }).state.doc.toString();
const expected = '1. First\n2. Second\n3. Third\n  1. Nested first\n  2. Nested second';

if (renumbered !== expected) {
  throw new Error(`Nested ordered lists must restart at 1. Received:\n${renumbered}`);
}

console.log('ordered list nesting renumber checks passed');
