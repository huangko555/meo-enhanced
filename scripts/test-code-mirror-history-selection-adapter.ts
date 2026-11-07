import assert from 'node:assert/strict';
import { ChangeSet, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { history, redo, redoDepth, undo, undoDepth, isolateHistory } from '@codemirror/commands';
import {
  createCodeMirrorHistorySelectionAdapter,
  isHistorySelectionValid,
  mapHistorySelection,
  type HistorySelection
} from '../webview/src/adapters/codeMirrorHistorySelectionAdapter';

function selection(ranges: HistorySelection['ranges'], mainIndex = 0): HistorySelection {
  return { ranges, mainIndex };
}

function historyHarness(text: string) {
  const adapter = createCodeMirrorHistorySelectionAdapter();
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

{
  const h = historyHarness('Before.\n\n<div><p>First</p><p>Second</p></div>\n\nAfter.');
  const before = selection([{ anchor: 46, head: 46 }]);
  const after = selection([{ anchor: 53, head: 53 }]);
  h.apply({ selection: before.ranges[0] });
  h.apply({
    changes: { from: 14, to: 45, insert: '<div>\n  <p>First</p>\n  <p>Second</p>\n</div>' },
    selection: after.ranges[0],
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.format')]
  });
  h.apply({ selection: { anchor: 0 } });
  assert.equal(h.undo(), true);
  assert.deepEqual(h.adapter.read(h.state), before,
    'undoing an input.format must expose its original selection after the user moved the caret');
  assert.equal(h.adapter.readExplicit(h.state), null,
    'automatic format selections must not claim the explicit search target priority');
  h.apply({ selection: { anchor: 1 } });
  assert.equal(h.redo(), true);
  assert.deepEqual(h.adapter.read(h.state), after,
    'redoing an input.format must expose its formatted selection after the user moved the caret');
  assert.equal(h.adapter.readExplicit(h.state), null);
}

for (const change of [
  { from: 1, insert: '++' },
  { from: 1, to: 4, insert: '' }
] as const) {
  const h = historyHarness('Before.\n\n<div><p>First</p><p>Second</p></div>\n\nAfter.');
  const before = selection([{ anchor: 46, head: 46 }]);
  const after = selection([{ anchor: 53, head: 53 }]);
  h.apply({ selection: before.ranges[0] });
  h.apply({
    changes: { from: 14, to: 45, insert: '<div>\n  <p>First</p>\n  <p>Second</p>\n</div>' },
    selection: after.ranges[0],
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.format')]
  });
  const mapping = ChangeSet.of([change], h.state.doc.length);
  h.apply({ changes: change, annotations: Transaction.addToHistory.of(false) });
  assert.equal(h.undo(), true);
  assert.deepEqual(h.adapter.read(h.state), mapHistorySelection(before, mapping),
    'input.format undo selection must rebase across a later nonhistory document change');
  assert.equal(h.redo(), true);
  assert.deepEqual(h.adapter.read(h.state), mapHistorySelection(after, mapping),
    'input.format redo selection must rebase across a later nonhistory document change');
}

{
  const h = historyHarness('abcdefghij');
  const firstBefore = selection([{ anchor: 10, head: 10 }]);
  const firstAfter = selection([{ anchor: 7, head: 7 }]);
  h.apply({ selection: firstBefore.ranges[0] });
  h.apply({ changes: { from: 1, to: 5, insert: 'WXYZ' }, selection: firstAfter.ranges[0],
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.format')] });
  const secondBefore = firstAfter;
  const secondAfter = selection([{ anchor: 6, head: 6 }]);
  h.apply({ changes: { from: 2, to: 6, insert: 'pqrs' }, selection: secondAfter.ranges[0],
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.format')] });
  assert.equal(h.undo(), true);
  assert.deepEqual(h.adapter.read(h.state), secondBefore,
    'the latest isolated input.format owns its undo selection in a format history sequence');
  assert.equal(h.undo(), true);
  assert.deepEqual(h.adapter.read(h.state), firstBefore,
    'earlier input.format restores its own selection after a composed history sequence');
  assert.equal(h.redo(), true);
  assert.deepEqual(h.adapter.read(h.state), firstAfter);
  assert.equal(h.redo(), true);
  assert.deepEqual(h.adapter.read(h.state), secondAfter);
}

{
  const h = historyHarness('abcdefghij');
  const explicitBefore = selection([{ anchor: 2, head: 4 }]);
  const explicitAfter = selection([{ anchor: 5, head: 7 }]);
  h.apply({ selection: { anchor: 10 } });
  h.apply({ changes: { from: 1, to: 5, insert: 'WXYZ' }, selection: explicitAfter.ranges[0],
    effects: h.adapter.effect(explicitAfter, explicitBefore),
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.format')] });
  assert.equal(h.undo(), true);
  assert.deepEqual(h.adapter.read(h.state), explicitBefore,
    'an explicit semantic selection remains authoritative when it shares an input.format history entry');
  assert.deepEqual(h.adapter.readExplicit(h.state), explicitBefore,
    'explicit targets retain their higher-priority search restoration semantics');
  assert.equal(h.redo(), true);
  assert.deepEqual(h.adapter.read(h.state), explicitAfter);
  assert.deepEqual(h.adapter.readExplicit(h.state), explicitAfter);
}

for (const changes of [
  ChangeSet.of([{ from: 2, insert: '++' }], 10),
  ChangeSet.of([{ from: 2, to: 6, insert: '' }], 10)
]) {
  const original = selection([{ anchor: 2, head: 6 }, { anchor: 8, head: 3 }, { anchor: 2, head: 2 }], 1);
  const expected = EditorSelection.create(original.ranges.map(range => EditorSelection.range(range.anchor, range.head)), original.mainIndex).map(changes);
  assert.deepEqual(mapHistorySelection(original, changes), {
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
  assert.deepEqual(h.adapter.read(h.state), mapHistorySelection(before, mapping),
    'undo semantic selection must survive a later nonhistory document change');
  assert.equal(h.redo(), true);
  assert.deepEqual(h.adapter.read(h.state), mapHistorySelection(after, mapping),
    'redo semantic selection must survive a later nonhistory document change');
}
assert.equal(isHistorySelectionValid(selection([{ anchor: 0, head: 1 }]), 1), true);
assert.equal(isHistorySelectionValid(selection([{ anchor: -1, head: 1 }]), 1), false);
assert.equal(isHistorySelectionValid(selection([], 0), 1), false);
assert.equal(isHistorySelectionValid(selection([{ anchor: 0, head: 2 }]), 1), false);
console.log('CodeMirror history selection adapter passed');
