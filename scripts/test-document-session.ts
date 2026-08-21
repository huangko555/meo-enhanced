import assert from 'node:assert/strict';
import {
  createDocumentSession,
  transitionDocumentSession
} from '../src/domain/documentSession';

const initial = createDocumentSession({
  documentId: 'file:///notes.md',
  revision: { number: 3, text: 'accepted' },
  savedRevision: { revisionNumber: 2, text: 'saved' }
});
const unassociatedSavedRevision = createDocumentSession({
  documentId: 'file:///dirty.md',
  revision: { number: 3, text: 'dirty' },
  savedRevision: { revisionNumber: null, text: 'saved disk' }
});
assert.deepEqual(unassociatedSavedRevision.savedRevision, {
  revisionNumber: null,
  text: 'saved disk'
});
const drafted = transitionDocumentSession(initial, { type: 'draftChanged', text: 'draft' });
assert.deepEqual(drafted.state.draft, { baseRevision: 3, text: 'draft' });
assert.deepEqual(drafted.effects, [
  { type: 'persistDraft', draft: { baseRevision: 3, text: 'draft' } }
]);

const submitted = transitionDocumentSession(drafted.state, { type: 'submitDraft' });
assert.deepEqual(submitted.state.pendingChange, { baseRevision: 3, text: 'draft' });
assert.deepEqual(submitted.effects, [
  { type: 'submitChange', change: { baseRevision: 3, text: 'draft' } }
]);
const duplicateSubmission = transitionDocumentSession(submitted.state, { type: 'submitDraft' });
assert.equal(duplicateSubmission.state, submitted.state);
assert.deepEqual(duplicateSubmission.effects, []);

const unchangedDraft = transitionDocumentSession(initial, { type: 'draftChanged', text: 'accepted' });
assert.equal(unchangedDraft.state.draft, null);
assert.deepEqual(unchangedDraft.effects, []);

const editedAgain = transitionDocumentSession(submitted.state, { type: 'draftChanged', text: 'newer draft' });
const accepted = transitionDocumentSession(editedAgain.state, {
  type: 'revisionReceived',
  revision: { number: 4, text: 'draft' }
});
assert.deepEqual(accepted.state.revision, { number: 4, text: 'draft' });
assert.deepEqual(accepted.state.draft, { baseRevision: 4, text: 'newer draft' });
assert.deepEqual(accepted.state.pendingChange, { baseRevision: 4, text: 'newer draft' });
assert.deepEqual(accepted.effects, [
  { type: 'persistDraft', draft: { baseRevision: 4, text: 'newer draft' } },
  { type: 'submitChange', change: { baseRevision: 4, text: 'newer draft' } }
]);

const latestAccepted = transitionDocumentSession(accepted.state, {
  type: 'revisionReceived',
  revision: { number: 5, text: 'newer draft' }
});
assert.equal(latestAccepted.state.draft, null);
assert.equal(latestAccepted.state.pendingChange, null);
assert.deepEqual(latestAccepted.effects, [{ type: 'persistDraft', draft: null }]);

const duplicateAcceptance = transitionDocumentSession(latestAccepted.state, {
  type: 'revisionReceived',
  revision: { number: 5, text: 'newer draft' }
});
assert.equal(duplicateAcceptance.state, latestAccepted.state);
assert.deepEqual(duplicateAcceptance.effects, []);

const externalWithoutDraft = transitionDocumentSession(initial, {
  type: 'revisionReceived',
  revision: { number: 4, text: 'remote' }
});
assert.deepEqual(externalWithoutDraft.state.revision, { number: 4, text: 'remote' });
assert.deepEqual(externalWithoutDraft.effects, [
  { type: 'presentText', text: 'remote', source: 'revision' }
]);

const rebaseBase = createDocumentSession({
  documentId: 'file:///rebase.md',
  revision: { number: 1, text: 'one\ntwo' },
  savedRevision: { revisionNumber: 1, text: 'one\ntwo' }
});
const disjointDraft = transitionDocumentSession(rebaseBase, {
  type: 'draftChanged',
  text: 'one\ntwo\nlocal'
});
const disjointExternal = transitionDocumentSession(disjointDraft.state, {
  type: 'revisionReceived',
  revision: { number: 2, text: 'remote\none\ntwo' }
});
const rebasedDraft = { baseRevision: 2, text: 'remote\none\ntwo\nlocal' };
assert.deepEqual(disjointExternal.state.revision, { number: 2, text: 'remote\none\ntwo' });
assert.deepEqual(disjointExternal.state.draft, rebasedDraft);
assert.deepEqual(disjointExternal.state.pendingChange, rebasedDraft);
assert.deepEqual(disjointExternal.effects, [
  { type: 'persistDraft', draft: rebasedDraft },
  { type: 'presentText', text: rebasedDraft.text, source: 'rebased-draft' },
  { type: 'submitChange', change: rebasedDraft }
]);

const overlappingDraft = transitionDocumentSession(rebaseBase, {
  type: 'draftChanged',
  text: 'one\nlocal'
});
const overlappingExternal = transitionDocumentSession(overlappingDraft.state, {
  type: 'revisionReceived',
  revision: { number: 2, text: 'one\nremote' }
});
assert.equal(overlappingExternal.state.draft, null);
assert.equal(overlappingExternal.state.pendingChange, null);
assert.deepEqual(overlappingExternal.effects, [
  { type: 'persistDraft', draft: null },
  { type: 'presentText', text: 'one\nremote', source: 'revision' }
]);

const staleRevision = transitionDocumentSession(externalWithoutDraft.state, {
  type: 'revisionReceived',
  revision: { number: 3, text: 'stale' }
});
assert.equal(staleRevision.state, externalWithoutDraft.state);
assert.deepEqual(staleRevision.effects, []);

const contradictoryRevision = transitionDocumentSession(externalWithoutDraft.state, {
  type: 'revisionReceived',
  revision: { number: 4, text: 'contradiction' }
});
assert.equal(contradictoryRevision.state, externalWithoutDraft.state);
assert.deepEqual(contradictoryRevision.effects, [{ type: 'requestResync' }]);

const contradictoryDiscard = transitionDocumentSession(externalWithoutDraft.state, {
  type: 'reloadedFromDisk',
  revision: { number: 4, text: 'contradictory discard' }
});
assert.equal(contradictoryDiscard.state, externalWithoutDraft.state);
assert.deepEqual(contradictoryDiscard.effects, [{ type: 'requestResync' }]);

const saveQueued = transitionDocumentSession(submitted.state, { type: 'saveRequested' });
assert.equal(saveQueued.state.savePhase, 'awaiting-change');
assert.deepEqual(saveQueued.effects, []);
const saveReady = transitionDocumentSession(saveQueued.state, {
  type: 'revisionReceived',
  revision: { number: 4, text: 'draft' }
});
assert.equal(saveReady.state.savePhase, 'saving');
assert.deepEqual(saveReady.effects, [
  { type: 'persistDraft', draft: null },
  { type: 'saveRevision', revision: { number: 4, text: 'draft' } }
]);
const saveCompleted = transitionDocumentSession(saveReady.state, {
  type: 'saveCompleted',
  revision: { number: 4, text: 'draft' }
});
assert.equal(saveCompleted.state.savePhase, 'idle');
assert.deepEqual(saveCompleted.state.savedRevision, { revisionNumber: 4, text: 'draft' });
assert.deepEqual(saveCompleted.effects, []);

const immediateSave = transitionDocumentSession(initial, { type: 'saveRequested' });
assert.equal(immediateSave.state.savePhase, 'saving');
assert.deepEqual(immediateSave.effects, [
  { type: 'saveRevision', revision: { number: 3, text: 'accepted' } }
]);
const duplicateSaveRequest = transitionDocumentSession(immediateSave.state, { type: 'saveRequested' });
assert.equal(duplicateSaveRequest.state, immediateSave.state);
assert.deepEqual(duplicateSaveRequest.effects, []);
const unrelatedSaveCompletion = transitionDocumentSession(immediateSave.state, {
  type: 'saveCompleted',
  revision: { number: 4, text: 'unaccepted' }
});
assert.equal(unrelatedSaveCompletion.state, immediateSave.state);
assert.deepEqual(unrelatedSaveCompletion.effects, []);
const unrelatedSaveFailure = transitionDocumentSession(immediateSave.state, {
  type: 'saveFailed',
  revision: { number: 4, text: 'unaccepted' }
});
assert.equal(unrelatedSaveFailure.state, immediateSave.state);
const saveFailed = transitionDocumentSession(immediateSave.state, {
  type: 'saveFailed',
  revision: { number: 3, text: 'accepted' }
});
assert.equal(saveFailed.state.savePhase, 'idle');
assert.deepEqual(saveFailed.state.savedRevision, initial.savedRevision);

const saveAfterConflict = transitionDocumentSession(saveQueued.state, {
  type: 'revisionReceived',
  revision: { number: 4, text: 'external wins' }
});
assert.equal(saveAfterConflict.state.savePhase, 'saving');
assert.deepEqual(saveAfterConflict.effects, [
  { type: 'persistDraft', draft: null },
  { type: 'presentText', text: 'external wins', source: 'revision' },
  { type: 'saveRevision', revision: { number: 4, text: 'external wins' } }
]);

const discarded = transitionDocumentSession(editedAgain.state, {
  type: 'reloadedFromDisk',
  revision: { number: 4, text: 'saved disk' }
});
assert.deepEqual(discarded.state.revision, { number: 4, text: 'saved disk' });
assert.deepEqual(discarded.state.savedRevision, { revisionNumber: 4, text: 'saved disk' });
assert.equal(discarded.state.draft, null);
assert.equal(discarded.state.pendingChange, null);
assert.equal(discarded.state.savePhase, 'idle');
assert.deepEqual(discarded.effects, [
  {
    type: 'presentText',
    text: 'saved disk',
    source: 'disk-reload',
    onPresented: 'discard-draft-recovery'
  }
]);

console.log('Document Session domain checks passed');
