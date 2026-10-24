import assert from 'node:assert/strict';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { createTableTransactionProvenance } from '../webview/src/application/tableTransactionProvenance';
import { createCodeMirrorTableTransactionProvenanceAdapter } from '../webview/src/adapters/codeMirrorTableTransactionProvenanceAdapter';
import { liveInputDerivedWorkExtensions } from '../webview/src/editor/liveInputDerivedWork';

// A toolbar command combines pending native text and row insertion. History's
// inverse effects must address the restored document, including when an input
// transaction extender maps them before the StateFields consume the undo.
for (const largeDocument of [false, true]) {
  const adapter = createCodeMirrorTableTransactionProvenanceAdapter(createTableTransactionProvenance());
  const original = '| A |\n| --- |\n| old |';
  let state = EditorState.create({ doc: original, extensions: [history(), adapter.extension,
    liveInputDerivedWorkExtensions({ largeDocument })] });
  const line = state.doc.line(3);
  const changes = state.changes([
    { from: line.from, to: line.to, insert: '| pending native text much longer than the original document |' },
    { from: line.to, insert: '\n| added |' }
  ]);
  state = state.update({ changes,
    effects: adapter.effect({ type: 'insertedRow', at: changes.mapPos(line.to, -1), assoc: -1, offset: 1 }),
    annotations: [Transaction.userEvent.of('input.table-command'), isolateHistory.of('full')]
  }).state;
  const after = state.doc.toString();
  assert.equal(adapter.snapshot().insertedRows.length, 1);
  const target = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  for (let round = 0; round < 3; round++) {
    assert.ok(undo(target));
    assert.equal(state.doc.toString(), original);
    assert.deepEqual(adapter.snapshot().insertedRows, []);
    assert.ok(redo(target));
    assert.equal(state.doc.toString(), after);
    const inserted = adapter.snapshot().insertedRows;
    assert.equal(inserted.length, 1);
    assert.equal(state.doc.sliceString(inserted[0].from, inserted[0].to), '| added |');
  }
  // Deletion intents and inserted-row identities share the same positioned
  // history effects. Their inverse must obey the restored coordinate space too.
  const first = state.doc.line(3), last = state.doc.line(4);
  const deletion = state.changes([
    { from: first.from, to: first.to, insert: '| even longer pending text '.repeat(5) + ' |' },
    { from: first.to, to: last.to, insert: '' }
  ]);
  state = state.update({ changes: deletion, effects: adapter.effect({ type: 'deletedRows',
    at: deletion.newLength, assoc: 1, baselineRanges: [[4, 4]], deletionAtEnd: true }),
    annotations: [Transaction.userEvent.of('input.table-command'), isolateHistory.of('full')]
  }).state;
  const deleted = state.doc.toString();
  for (let round = 0; round < 3; round++) {
    assert.ok(undo(target));
    assert.equal(state.doc.toString(), after);
    assert.equal(adapter.snapshot().insertedRows.length, 1);
    assert.deepEqual(adapter.snapshot().deletedRows, []);
    assert.ok(redo(target));
    assert.equal(state.doc.toString(), deleted);
    assert.deepEqual(adapter.snapshot().insertedRows, []);
    assert.equal(adapter.snapshot().deletedRows[0].at, state.doc.length);
  }
}
console.log('Table provenance history: combined native edit/command with real input extenders passed');
