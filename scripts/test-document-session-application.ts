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
  type: 'localDraftChanged', text: 'one\ntwo\nlocal', receiptVersion: 1
}), [
  { type: 'rememberDraft', text: 'one\ntwo\nlocal', receiptVersion: 1 }
]);
assert.deepEqual(localEdit.handle({ type: 'submitPendingDraft' }), [
  {
    type: 'applyTextChange',
    baseVersion: 3,
    changes: [{ from: 0, to: 7, insert: 'one\ntwo\nlocal' }]
  }
]);
assert.deepEqual(localEdit.handle({ type: 'hostChangeApplied', version: 4 }), [
  { type: 'rememberDraft', text: null, receiptVersion: 2 }
]);
assert.deepEqual(localEdit.handle({ type: 'hostChangeApplied', version: 4 }), []);
assert.deepEqual(localEdit.handle({ type: 'hostChangeApplied', version: 3 }), []);

const orderedEdits = createCoordinator();
orderedEdits.handle({ type: 'localDraftChanged', text: 'first edit', receiptVersion: 1 });
orderedEdits.handle({ type: 'submitPendingDraft' });
orderedEdits.handle({ type: 'localDraftChanged', text: 'second edit', receiptVersion: 2 });
assert.deepEqual(orderedEdits.handle({ type: 'hostChangeApplied', version: 4 }), [
  { type: 'rememberDraft', text: 'second edit', receiptVersion: 3 },
  {
    type: 'applyTextChange',
    baseVersion: 4,
    changes: [{ from: 0, to: 10, insert: 'second edit' }]
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
disjoint.handle({ type: 'localDraftChanged', text: 'one\ntwo\nlocal', receiptVersion: 1 });
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
    changes: [{ from: 0, to: 14, insert: 'remote\none\ntwo\nlocal' }]
  }
]);

const overlap = createCoordinator();
overlap.handle({ type: 'localDraftChanged', text: 'one\nlocal', receiptVersion: 1 });
assert.deepEqual(overlap.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'one\nremote'
}), [
  { type: 'rememberDraft', text: null, receiptVersion: 2 },
  { type: 'presentText', text: 'one\nremote', source: 'revision' }
]);

const saveAfterEdit = createCoordinator();
saveAfterEdit.handle({ type: 'localDraftChanged', text: 'one\ntwo\nlocal', receiptVersion: 1 });
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
saveAfterConflict.handle({ type: 'localDraftChanged', text: 'one\nlocal', receiptVersion: 1 });
saveAfterConflict.handle({ type: 'submitPendingDraft' });
saveAfterConflict.handle({ type: 'saveRequested' });
assert.deepEqual(saveAfterConflict.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'one\nremote'
}), [
  { type: 'rememberDraft', text: null, receiptVersion: 2 },
  { type: 'presentText', text: 'one\nremote', source: 'revision' },
  { type: 'saveDocument', revision: { number: 4, text: 'one\nremote' } }
]);

const discarded = createCoordinator();
discarded.handle({ type: 'localDraftChanged', text: 'one\nlocal', receiptVersion: 1 });
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

console.log('Document Session application contract checks passed');
