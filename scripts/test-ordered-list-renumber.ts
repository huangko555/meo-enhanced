import { EditorState } from '@codemirror/state';
import { orderedListRenumberTransactionFilter, listMarkerData } from '../webview/src/helpers/listMarkers';

const state = EditorState.create({
  doc: '1. First\n99. Second\n3. Third\n  4. Nested first\n  5. Nested second',
  extensions: orderedListRenumberTransactionFilter(() => true)
});
const nestedMarker = listMarkerData('  4. Nested first');
if (nestedMarker?.indentLevel !== 1) {
  throw new Error(`Expected the indented item to be at level 1, received ${nestedMarker?.indentLevel}`);
}
const firstLine = state.doc.line(1);
const renumbered = state.update({ changes: { from: firstLine.to, insert: '!' } }).state.doc.toString();
const expected = '1. First!\n2. Second\n3. Third\n  4. Nested first\n  5. Nested second';

if (renumbered !== expected) {
  throw new Error(`Nested ordered lists must preserve an explicit start. Received:\n${renumbered}`);
}

console.log('ordered list nesting renumber checks passed');
