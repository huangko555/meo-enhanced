import assert from 'node:assert/strict';
import { createDocumentSessionCoordinator } from '../src/application/documentSession';

const createCoordinator = () => createDocumentSessionCoordinator({
  documentId: 'file:///notes.md',
  revision: { number: 3, text: 'one\ntwo' },
  savedRevision: { revisionNumber: 2, text: 'one' }
});

const initialized = createCoordinator();
assert.deepEqual(initialized.handle({
  type: 'hostRevisionChanged',
  version: 3,
  text: 'one\ntwo'
}), []);

const localEdit = createCoordinator();
assert.deepEqual(localEdit.handle({
  type: 'localDraftChanged', text: 'one\ntwo\nlocal'
}), [
  { type: 'rememberDraft', text: 'one\ntwo\nlocal', receiptVersion: 1 }
]);
assert.deepEqual(localEdit.handle({ type: 'submitPendingDraft' }), [
  {
    type: 'applyTextChange',
    baseVersion: 3,
    changes: [{ from: 7, to: 7, insert: '\nlocal' }]
  }
]);
assert.deepEqual(localEdit.handle({ type: 'hostChangeApplied', version: 4 }), [
  { type: 'rememberDraft', text: null, receiptVersion: 2 }
]);
assert.deepEqual(localEdit.handle({ type: 'hostChangeApplied', version: 4 }), []);
assert.deepEqual(localEdit.handle({ type: 'hostChangeApplied', version: 3 }), []);

const staleEchoAfterInsert = createCoordinator();
staleEchoAfterInsert.handle({ type: 'localDraftChanged', text: 'one\ntwo\nlocal' });
assert.deepEqual(staleEchoAfterInsert.handle({
  type: 'hostRevisionChanged',
  version: 3,
  text: 'one\ntwo'
}), []);
assert.deepEqual(staleEchoAfterInsert.handle({ type: 'submitPendingDraft' }), [
  {
    type: 'applyTextChange',
    baseVersion: 3,
    changes: [{ from: 7, to: 7, insert: '\nlocal' }]
  }
]);

const staleEchoAfterDelete = createCoordinator();
staleEchoAfterDelete.handle({ type: 'localDraftChanged', text: 'one' });
assert.deepEqual(staleEchoAfterDelete.handle({
  type: 'hostRevisionChanged',
  version: 3,
  text: 'one\ntwo'
}), []);
assert.deepEqual(staleEchoAfterDelete.handle({ type: 'submitPendingDraft' }), [
  {
    type: 'applyTextChange',
    baseVersion: 3,
    changes: [{ from: 3, to: 7, insert: '' }]
  }
]);

const orderedEdits = createCoordinator();
orderedEdits.handle({ type: 'localDraftChanged', text: 'first edit' });
orderedEdits.handle({ type: 'submitPendingDraft' });
orderedEdits.handle({ type: 'localDraftChanged', text: 'second edit' });
assert.deepEqual(orderedEdits.handle({ type: 'hostChangeApplied', version: 4 }), [
  { type: 'rememberDraft', text: 'second edit', receiptVersion: 3 },
  {
    type: 'applyTextChange',
    baseVersion: 4,
    changes: [{ from: 0, to: 5, insert: 'second' }]
  }
]);
assert.deepEqual(orderedEdits.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'first edit'
}), []);

const external = createCoordinator();
assert.deepEqual(external.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'remote\none\ntwo'
}), [
  { type: 'presentText', text: 'remote\none\ntwo', source: 'revision' }
]);
assert.deepEqual(external.handle({
  type: 'hostRevisionChanged',
  version: 3,
  text: 'late'
}), []);

const disjoint = createCoordinator();
disjoint.handle({ type: 'localDraftChanged', text: 'one\ntwo\nlocal' });
assert.deepEqual(disjoint.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'remote\none\ntwo'
}), [
  { type: 'rememberDraft', text: 'remote\none\ntwo\nlocal', receiptVersion: 2 },
  { type: 'presentText', text: 'remote\none\ntwo\nlocal', source: 'rebased-draft' },
  {
    type: 'applyTextChange',
    baseVersion: 4,
    changes: [{ from: 14, to: 14, insert: '\nlocal' }]
  }
]);

const overlap = createCoordinator();
overlap.handle({ type: 'localDraftChanged', text: 'one\nlocal' });
assert.deepEqual(overlap.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'one\nremote'
}), [{ type: 'showExternalConflict' }]);

const saveAfterEdit = createCoordinator();
saveAfterEdit.handle({ type: 'localDraftChanged', text: 'one\ntwo\nlocal' });
saveAfterEdit.handle({ type: 'submitPendingDraft' });
assert.deepEqual(saveAfterEdit.handle({ type: 'saveRequested' }), []);
assert.deepEqual(saveAfterEdit.handle({ type: 'hostChangeApplied', version: 4 }), [
  { type: 'rememberDraft', text: null, receiptVersion: 2 },
  { type: 'saveDocument', revision: { number: 4, text: 'one\ntwo\nlocal' } }
]);
assert.deepEqual(saveAfterEdit.handle({
  type: 'hostSaveSucceeded',
  version: 4,
  text: 'one\ntwo\nlocal'
}), []);
assert.deepEqual(saveAfterEdit.handle({
  type: 'hostSaveSucceeded',
  version: 4,
  text: 'one\ntwo\nlocal'
}), []);

const immediateSave = createCoordinator();
assert.deepEqual(immediateSave.handle({ type: 'saveRequested' }), [
  { type: 'saveDocument', revision: { number: 3, text: 'one\ntwo' } }
]);
assert.deepEqual(immediateSave.handle({ type: 'saveRequested' }), []);
assert.deepEqual(immediateSave.handle({
  type: 'hostSaveSucceeded',
  version: 4,
  text: 'unrelated revision'
}), []);
assert.deepEqual(immediateSave.handle({ type: 'saveRequested' }), []);
assert.deepEqual(immediateSave.handle({
  type: 'hostSaveFailed',
  version: 4,
  text: 'unrelated revision'
}), []);
assert.deepEqual(immediateSave.handle({ type: 'saveRequested' }), []);
assert.deepEqual(immediateSave.handle({
  type: 'hostSaveFailed',
  version: 3,
  text: 'one\ntwo'
}), []);
assert.deepEqual(immediateSave.handle({ type: 'saveRequested' }), [
  { type: 'saveDocument', revision: { number: 3, text: 'one\ntwo' } }
]);

const saveAfterConflict = createCoordinator();
saveAfterConflict.handle({ type: 'localDraftChanged', text: 'one\nlocal' });
saveAfterConflict.handle({ type: 'submitPendingDraft' });
saveAfterConflict.handle({ type: 'saveRequested' });
assert.deepEqual(saveAfterConflict.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'one\nremote'
}), [{ type: 'showExternalConflict' }]);

const discarded = createCoordinator();
discarded.handle({ type: 'localDraftChanged', text: 'one\nlocal' });
assert.deepEqual(discarded.handle({
  type: 'hostReloadedFromDisk',
  version: 4,
  text: 'saved disk'
}), [
  {
    type: 'presentText',
    text: 'saved disk',
    source: 'disk-reload',
    onPresented: 'discard-draft-recovery'
  }
]);

// A local edit must not send unchanged document content back to the Host.
const largeBase = 'unchanged paragraph\n'.repeat(10_000);
const middle = Math.floor(largeBase.length / 2);
const boundedChange = createDocumentSessionCoordinator({
  documentId: 'file:///large.md',
  revision: { number: 1, text: largeBase },
  savedRevision: { revisionNumber: 1, text: largeBase }
});
boundedChange.handle({
  type: 'localDraftChanged',
  text: largeBase.slice(0, middle) + 'X' + largeBase.slice(middle)
});
const boundedActions = boundedChange.handle({ type: 'submitPendingDraft' });
assert.equal(boundedActions[0]?.type, 'applyTextChange');
if (boundedActions[0]?.type === 'applyTextChange') {
  assert.equal(boundedActions[0].changes[0]?.insert.length, 1, 'unchanged text must not be transmitted');
}
assert.deepEqual(boundedActions, [{
  type: 'applyTextChange', baseVersion: 1,
  changes: [{ from: middle, to: middle, insert: 'X' }]
}], 'single-character input must submit only its changed range');

// Exercise the production Interface across insertion, deletion, replacement,
// disjoint edits and UTF-16 boundaries rather than a private diff helper.
const replacementCases = [
  ['', 'new'], ['old', ''], ['same', 'different'],
  ['prefix suffix', 'prefix NEW suffix'], ['prefix OLD suffix', 'prefix suffix'],
  ['a\nb\nc', 'A\nb\nC'], ['中文正文', '中文新正文'],
  ['a😀z', 'a😁z'], ['a😀z', 'a🈀z'], ['😀tail', 'tail'],
  ['head', 'head😀'], ['a\nb', 'a\n\nb']
] as const;
for (const [before, after] of replacementCases) {
  const coordinator = createDocumentSessionCoordinator({
    documentId: 'file:///replacement.md',
    revision: { number: 1, text: before },
    savedRevision: { revisionNumber: 1, text: before }
  });
  coordinator.handle({ type: 'localDraftChanged', text: after });
  const actions = coordinator.handle({ type: 'saveRequested' });
  const action = actions.find(action => action.type === 'applyTextChange');
  assert.ok(action);
  let actual = before;
  for (const change of [...action.changes].sort((a, b) => b.from - a.from)) {
    assert.ok(change.from >= 0 && change.to >= change.from && change.to <= before.length);
    assert.equal(change.insert.isWellFormed(), true, 'transport must preserve complete Unicode characters');
    actual = actual.slice(0, change.from) + change.insert + actual.slice(change.to);
  }
  assert.equal(actual, after);
  assert.deepEqual(coordinator.handle({ type: 'hostChangeApplied', version: 2 }), [
    { type: 'rememberDraft', text: null, receiptVersion: 2 },
    { type: 'saveDocument', revision: { number: 2, text: after } }
  ]);
}

console.log('Document Session application contract checks passed');
