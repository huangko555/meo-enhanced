import assert from 'node:assert/strict';
import { ChangeSet, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { history, redo, redoDepth, undo, undoDepth, isolateHistory } from '@codemirror/commands';
import {
  createCodeMirrorSearchHistoryFocusAdapter,
  isSearchHistorySelectionValid,
  mapSearchHistorySelection,
  type SearchHistorySelection
} from '../webview/src/adapters/codeMirrorSearchHistoryFocusAdapter';

function selection(ranges: SearchHistorySelection['ranges'], mainIndex = 0): SearchHistorySelection {
  return { ranges, mainIndex };
}

function historyHarness(text: string) {
  const adapter = createCodeMirrorSearchHistoryFocusAdapter();
  let state = EditorState.create({ doc: text, extensions: [history(), adapter.extension] });
  return {
    adapter,
    get state() { return state; },
    apply(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state; },
    undo() { return undo({ get state() { return state; }, dispatch(transaction) { state = transaction.state; } }); },
    redo() { return redo({ get state() { return state; }, dispatch(transaction) { state = transaction.state; } }); }
  };
}

{
  const h = historyHarness('needleneedleneedle');
  const firstBefore = selection([{ anchor: 0, head: 6 }]);
  const firstAfter = selection([{ anchor: 1, head: 7 }]);
  h.apply({ changes: { from: 0, to: 6, insert: 'x' }, selection: firstAfter.ranges[0],
    effects: h.adapter.effect(firstAfter, firstBefore), annotations: isolateHistory.of('full') });
  const secondBefore = selection([{ anchor: 1, head: 7 }]);
  const secondAfter = selection([{ anchor: 2, head: 8 }]);
  h.apply({ changes: { from: 1, to: 7, insert: 'x' }, selection: secondAfter.ranges[0],
    effects: h.adapter.effect(secondAfter, secondBefore), annotations: isolateHistory.of('full') });
  assert.equal(h.state.doc.toString(), 'xxneedle');
  assert.equal(undoDepth(h.state), 2, 'adjacent replacements must not merge');
  assert.equal(h.undo(), true); assert.equal(h.state.doc.toString(), 'xneedleneedle');
  assert.deepEqual(h.adapter.read(h.state), secondBefore, 'undo must restore the second replacement boundary');
  assert.equal(h.undo(), true); assert.equal(h.state.doc.toString(), 'needleneedleneedle');
  assert.deepEqual(h.adapter.read(h.state), firstBefore, 'undo must restore the first replacement boundary');
  assert.equal(h.redo(), true); assert.equal(h.state.doc.toString(), 'xneedleneedle');
  assert.deepEqual(h.adapter.read(h.state), firstAfter, 'first redo must restore its own next match');
  assert.equal(h.redo(), true); assert.equal(h.state.doc.toString(), 'xxneedle');
  assert.deepEqual(h.adapter.read(h.state), secondAfter, 'second redo must not revive the first target');
}

{
  const h = historyHarness('needleneedle');
  const before = selection([{ anchor: 0, head: 6 }]);
  const next = selection([{ anchor: 1, head: 7 }]);
  h.apply({ changes: { from: 0, to: 6, insert: 'x' }, selection: next.ranges[0],
    effects: h.adapter.effect(next, before), annotations: isolateHistory.of('full') });
  h.apply({ changes: { from: 1, to: 7, insert: 'Z' }, selection: { anchor: 2 }, annotations: Transaction.userEvent.of('input.type') });
  assert.equal(undoDepth(h.state), 2, 'ordinary input after replacement must stay separate');
  assert.equal(h.undo(), true); assert.equal(h.state.doc.toString(), 'xneedle');
  assert.equal(h.adapter.read(h.state), null, 'undoing ordinary input must not expose an older search target');
  assert.equal(h.redo(), true); assert.equal(h.state.doc.toString(), 'xZ');
  assert.equal(h.adapter.read(h.state), null, 'redoing ordinary input must not revive an older search target');
  assert.equal(redoDepth(h.state), 0);
}

for (const changes of [
  ChangeSet.of([{ from: 2, insert: '++' }], 10),
  ChangeSet.of([{ from: 2, to: 6, insert: '' }], 10)
]) {
  const original = selection([{ anchor: 2, head: 6 }, { anchor: 8, head: 3 }, { anchor: 2, head: 2 }], 1);
  const expected = EditorSelection.create(original.ranges.map(range => EditorSelection.range(range.anchor, range.head)), original.mainIndex).map(changes);
  assert.deepEqual(mapSearchHistorySelection(original, changes), {
    ranges: expected.ranges.map(range => ({ anchor: range.anchor, head: range.head })), mainIndex: expected.mainIndex
  }, 'semantic selection mapping must match CodeMirror exactly');
}

for (const change of [
  { from: 2, insert: '++' },
  { from: 2, to: 6, insert: '' }
] as const) {
  const h = historyHarness('0123456789');
  const before = selection([{ anchor: 2, head: 6 }, { anchor: 8, head: 3 }, { anchor: 2, head: 2 }], 1);
  const after = selection([{ anchor: 3, head: 7 }, { anchor: 9, head: 4 }, { anchor: 3, head: 3 }], 1);
  h.apply({ changes: { from: 0, to: 1, insert: 'X' }, selection: after.ranges[after.mainIndex],
    effects: h.adapter.effect(after, before), annotations: isolateHistory.of('full') });
  const mapping = ChangeSet.of([change], h.state.doc.length);
  h.apply({ changes: change, annotations: Transaction.addToHistory.of(false) });
  assert.equal(h.undo(), true);
  assert.deepEqual(h.adapter.read(h.state), mapSearchHistorySelection(before, mapping),
    'undo semantic selection must survive a later nonhistory document change');
  assert.equal(h.redo(), true);
  assert.deepEqual(h.adapter.read(h.state), mapSearchHistorySelection(after, mapping),
    'redo semantic selection must survive a later nonhistory document change');
}
assert.equal(isSearchHistorySelectionValid(selection([{ anchor: 0, head: 1 }]), 1), true);
assert.equal(isSearchHistorySelectionValid(selection([{ anchor: -1, head: 1 }]), 1), false);
assert.equal(isSearchHistorySelectionValid(selection([], 0), 1), false);
assert.equal(isSearchHistorySelectionValid(selection([{ anchor: 0, head: 2 }]), 1), false);
console.log('CodeMirror search history focus adapter passed');
