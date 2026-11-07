import assert from 'node:assert/strict';
import { createDocumentSessionCoordinator, type DocumentSessionAction, type DocumentSessionInput } from '../src/application/documentSession';
import { readDocumentText } from '../src/foundation/documentSnapshot';
import { documentEdit, documentSnapshotFromString } from '../webview/src/adapters/documentSnapshot';
import { ChangeSet, Text } from '@codemirror/state';

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
  { type: 'rememberDraft', text: 'one\ntwo\nlocal', baseVersion: 3, receiptVersion: 1 }
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
  { type: 'rememberDraft', text: 'second edit', baseVersion: 4, receiptVersion: 3 },
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
  { type: 'rememberDraft', text: 'remote\none\ntwo\nlocal', baseVersion: 4, receiptVersion: 2 },
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
}), [
  { type: 'rememberDraft', text: 'one\nlocal', baseVersion: 3, conflictBaseText: 'one\ntwo', receiptVersion: 2 },
  { type: 'showExternalConflict' }
]);

// The editor can accept a local transaction while a newer Host revision waits
// behind an in-flight save. Its real before/after edit must be rebased onto
// that revision, not treated as a stale whole-document replacement.
{
  const coordinator = createDocumentSessionCoordinator({
    documentId: 'file:///stale-local-edit.md',
    revision: { number: 1, text: 'abc' },
    savedRevision: { revisionNumber: 1, text: 'abc' }
  });
  const before = Text.of(['abc']);
  const changes = ChangeSet.of({ from: 3, to: 3, insert: '!' }, before.length);
  const after = changes.apply(before);
  const edit = documentEdit(changes, before, after);
  coordinator.handle({ type: 'hostRevisionChanged', version: 2, text: 'Abc' });
  assert.deepEqual(coordinator.handle({
    type: 'localDraftChanged', text: edit.after,
    edit
  }).map(action => action.type === 'rememberDraft' ? { ...action, text: readDocumentText(action.text!) } : action), [
    { type: 'rememberDraft', text: 'Abc!', baseVersion: 2, receiptVersion: 2 },
    { type: 'presentText', text: 'Abc!', source: 'rebased-draft' }
  ]);
}

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
}), [
  { type: 'rememberDraft', text: 'one\nlocal', baseVersion: 3, conflictBaseText: 'one\ntwo', receiptVersion: 2 },
  { type: 'showExternalConflict' }
]);

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

// Compare the new snapshot/transaction path with the existing string semantics,
// including edits queued behind ACKs and surrogate-pair boundary replacements.
{
  const initial = 'head 😀 middle 😁 tail\nsecond line';
  const options = { documentId: 'file:///transaction-semantics.md', revision: { number: 1, text: initial },
    savedRevision: { revisionNumber: 1, text: initial } };
  const plain = createDocumentSessionCoordinator(options);
  const snapshots = createDocumentSessionCoordinator({ ...options, createTextSnapshot: documentSnapshotFromString });
  const revisions = new Map([[1, initial]]);
  const replies: number[] = [];
  let hostVersion = 1;
  let value = Text.of(initial.split('\n'));
  const project = (actions: readonly DocumentSessionAction[]) => actions.map(action => {
    if (action.type === 'rememberDraft') return { type: action.type, receiptVersion: action.receiptVersion,
      text: action.text === null ? null : readDocumentText(action.text) };
    if (action.type === 'saveDocument') return { type: action.type,
      revision: { ...action.revision, text: readDocumentText(action.revision.text) } };
    if (action.type !== 'applyTextChange') return action;
    const base = revisions.get(action.baseVersion);
    assert.notEqual(base, undefined);
    let text = base!;
    for (const change of [...action.changes].reverse()) {
      assert.ok(change.from >= 0 && change.to <= base!.length);
      if (base!.isWellFormed() && value.toString().isWellFormed()) assert.ok(change.insert.isWellFormed());
      text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    }
    return { type: action.type, baseVersion: action.baseVersion, text };
  });
  const compare = (plainInput: DocumentSessionInput, snapshotInput = plainInput) => {
    const left = plain.handle(plainInput);
    const right = snapshots.handle(snapshotInput);
    assert.deepEqual(project(right), project(left));
    for (const action of project(right)) {
      if (action.type === 'applyTextChange' && 'text' in action) {
        assert.equal(action.baseVersion, hostVersion);
        revisions.set(++hostVersion, action.text as string);
        replies.push(hostVersion);
      }
    }
  };
  for (let index = 0; index < 120; index += 1) {
    const from = index === 0 ? 6 : (index * 17) % value.length;
    const changes = ChangeSet.of({ from, to: Math.min(value.length, from + index % 3),
      insert: ['中文', '😀', '', '\nline', 'x'][index % 5] }, value.length);
    const next = changes.apply(value);
    const edit = documentEdit(changes, value, next);
    value = next;
    compare({ type: 'localDraftChanged', text: next.toString() },
      { type: 'localDraftChanged', text: edit.after, edit });
    compare({ type: 'submitPendingDraft' });
    if (index % 7 === 0 && replies.length) compare({ type: 'hostChangeApplied', version: replies.shift()! });
  }
  while (replies.length) compare({ type: 'hostChangeApplied', version: replies.shift()! });
  assert.equal(revisions.get(hostVersion), value.toString());
  compare({ type: 'saveRequested' });
  compare({ type: 'hostSaveSucceeded', version: hostVersion, text: value.toString() });
  compare({ type: 'hostRevisionChanged', version: hostVersion - 1, text: 'stale' });
  compare({ type: 'hostRevisionChanged', version: hostVersion + 1, text: 'external\n' + value.toString() });
}

// A native table textarea may be confirmed by the browser while its 250 ms
// CodeMirror commit boundary is still pending. Its recovery projection must
// not become a submit-able Draft, and an acknowledgement for an older normal
// edit must not clear that newer recovery candidate.
const nativeProjection = createCoordinator();
const committedText = 'one\ntwo\nnormal';
assert.deepEqual(nativeProjection.handle({ type: 'localDraftChanged', text: committedText }), [
  { type: 'rememberDraft', text: committedText, baseVersion: 3, receiptVersion: 1 }
]);
nativeProjection.handle({ type: 'submitPendingDraft' });
const projectedText = `${committedText}\nnative`;
assert.deepEqual(nativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: committedText, text: projectedText
}), [
  { type: 'rememberDraft', text: projectedText, baseVersion: 3, receiptVersion: 2 }
]);
assert.equal(readDocumentText(nativeProjection.currentText()), committedText,
  'a recovery projection must not mutate the Document Session Draft');
assert.deepEqual(nativeProjection.handle({ type: 'hostChangeApplied', version: 4 }), [
  { type: 'rememberDraft', text: projectedText, baseVersion: 4, receiptVersion: 3 }
]);
assert.equal(readDocumentText(nativeProjection.currentText()), committedText,
  'an older Host acknowledgement must not submit native input early');
assert.deepEqual(nativeProjection.handle({ type: 'localDraftChanged', text: projectedText }), [
  { type: 'rememberDraft', text: projectedText, baseVersion: 4, receiptVersion: 4 }
]);
assert.deepEqual(nativeProjection.handle({ type: 'submitPendingDraft' }), [
  {
    type: 'applyTextChange',
    baseVersion: 4,
    changes: [{ from: committedText.length, to: committedText.length, insert: '\nnative' }]
  }
]);

const revertedNativeProjection = createCoordinator();
assert.deepEqual(revertedNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: 'one\ntwo', text: 'one\ntwo'
}), [{ type: 'rememberDraft', text: null, receiptVersion: 1 }]);

const invalidatedNativeProjection = createCoordinator();
const nativeSource = Text.of(['one', 'two']);
const nativeChanges = ChangeSet.of({ from: nativeSource.length, to: nativeSource.length, insert: '\nnative' }, nativeSource.length);
const nativeEdit = documentEdit(nativeChanges, nativeSource, nativeChanges.apply(nativeSource));
const acceptedNativeProjection = createCoordinator();
acceptedNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: nativeEdit.before, text: nativeEdit.after, edit: nativeEdit
});
const acceptedNativeActions = acceptedNativeProjection.handle({
  type: 'hostRevisionChanged', version: 4, text: nativeEdit.after
});
assert.deepEqual(acceptedNativeActions.filter(action => action.type === 'presentText'), [{
  type: 'presentText', text: 'one\ntwo\nnative', source: 'rebased-draft'
}], 'Host convergence must retain pending native history through one final presentation');
assert.deepEqual(acceptedNativeActions.filter(action => action.type === 'rememberDraft'), [{
  type: 'rememberDraft', text: null, receiptVersion: 2
}], 'Host convergence must clear the obsolete native recovery candidate');
assert.equal(acceptedNativeActions.some(action => action.type === 'applyTextChange'), false);
assert.equal(acceptedNativeProjection.handle({
  type: 'hostRevisionChanged', version: 5, text: 'later Host source'
}).some(action => action.type === 'rememberDraft' && action.text !== null), false,
'A later Host source must not revive an already accepted native projection');
invalidatedNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: nativeEdit.before, text: nativeEdit.after, edit: nativeEdit });
const invalidationActions = invalidatedNativeProjection.handle({
  type: 'hostRevisionChanged', version: 4, text: 'remote\none\ntwo'
});
assert.ok(invalidationActions.some(action => action.type === 'rememberDraft'
  && readDocumentText(action.text ?? '') === 'remote\none\ntwo\nnative' && action.baseVersion === 4),
  'a disjoint external change must rebase the native recovery projection instead of clearing it');
assert.ok(invalidationActions.some(action => action.type === 'presentText'
  && action.text === 'remote\none\ntwo\nnative' && action.source === 'rebased-draft'),
  'a disjoint external change must present the rebased native recovery projection');
assert.deepEqual(invalidationActions.filter(action => action.type === 'presentText').map(action => action.text),
  ['remote\none\ntwo\nnative'], 'one external intent must present only its final native-rebased text');
assert.ok(!invalidationActions.some(action => action.type === 'applyTextChange'),
  'an external rebase must not submit native input before its normal table commit boundary');

const successiveNativeProjection = createCoordinator();
const firstNativeChanges = ChangeSet.of({ from: nativeSource.length, to: nativeSource.length, insert: '\nfirst' }, nativeSource.length);
const firstNativeText = firstNativeChanges.apply(nativeSource);
const firstNativeEdit = documentEdit(firstNativeChanges, nativeSource, firstNativeText);
successiveNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: firstNativeEdit.before, text: firstNativeEdit.after, edit: firstNativeEdit
});
const secondNativeChanges = ChangeSet.of({ from: firstNativeText.length, to: firstNativeText.length, insert: '\nsecond' }, firstNativeText.length);
const secondNativeText = secondNativeChanges.apply(firstNativeText);
const secondNativeEdit = documentEdit(secondNativeChanges, firstNativeText, secondNativeText);
successiveNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: firstNativeEdit.before, text: secondNativeEdit.after, edit: secondNativeEdit
});
const successiveRebaseActions = successiveNativeProjection.handle({
  type: 'hostRevisionChanged', version: 4, text: 'remote\none\ntwo'
});
assert.deepEqual(successiveRebaseActions.filter(action => action.type === 'presentText'), [{
  type: 'presentText', text: 'remote\none\ntwo\nfirst\nsecond', source: 'rebased-draft'
}], 'successive native deltas must rebase from the original source once, without an intermediate Host presentation');
assert.ok(successiveRebaseActions.some(action => action.type === 'rememberDraft'
  && readDocumentText(action.text ?? '') === 'remote\none\ntwo\nfirst\nsecond' && action.baseVersion === 4),
  'a later native delta must retain every earlier native character through a disjoint external rebase');

const successiveNativeConflict = createCoordinator();
successiveNativeConflict.handle({
  type: 'localRecoveryDraftChanged', source: firstNativeEdit.before, text: firstNativeEdit.after, edit: firstNativeEdit
});
successiveNativeConflict.handle({
  type: 'localRecoveryDraftChanged', source: firstNativeEdit.before, text: secondNativeEdit.after, edit: secondNativeEdit
});
const successiveConflictActions = successiveNativeConflict.handle({
  type: 'hostRevisionChanged', version: 4, text: 'one\ntwo\nremote'
});
assert.deepEqual(successiveConflictActions.filter(action => action.type === 'presentText'), [{
  type: 'presentText', text: 'one\ntwo\nfirst\nsecond', source: 'rebased-draft'
}], 'a native overlap must present its one current conflicting Draft, not a stale intermediate source');
assert.ok(successiveConflictActions.some(action => action.type === 'rememberDraft'
  && readDocumentText(action.text ?? '') === 'one\ntwo\nfirst\nsecond'
  && readDocumentText(action.conflictBaseText ?? '') === 'one\ntwo' && action.baseVersion === 4),
  'a later native delta must preserve every local character and the original conflict base');

const conflictingNativeProjection = createCoordinator();
const overlappingChanges = ChangeSet.of({ from: 0, to: 3, insert: 'local' }, nativeSource.length);
const conflictText = overlappingChanges.apply(nativeSource);
const overlappingEdit = documentEdit(overlappingChanges, nativeSource, conflictText);
conflictingNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: overlappingEdit.before, text: overlappingEdit.after, edit: overlappingEdit });
const conflictActions = conflictingNativeProjection.handle({
  type: 'hostRevisionChanged', version: 4, text: 'remote\ntwo'
});
assert.ok(conflictActions.some(action => action.type === 'rememberDraft'
  && readDocumentText(action.text ?? '') === 'local\ntwo' && readDocumentText(action.conflictBaseText ?? '') === 'one\ntwo'),
  'an overlapping external change must retain the native value as a conflict candidate');
assert.ok(conflictActions.some(action => action.type === 'showExternalConflict'),
  'an overlapping external change must use the existing conflict notice path');
assert.ok(conflictActions.some(action => action.type === 'presentText'
  && action.text === 'local\ntwo' && action.source === 'rebased-draft'),
  'the editor must present the current conflicting Draft so UI and session source stay aligned');
assert.ok(!conflictActions.some(action => action.type === 'applyTextChange'),
  'presenting a conflicting Draft must not overwrite the external Host revision');
const conflictSource = conflictText;
const conflictFollowUpChanges = ChangeSet.of({ from: conflictSource.length, to: conflictSource.length, insert: '\nnative' }, conflictSource.length);
const conflictFollowUp = documentEdit(conflictFollowUpChanges, conflictSource, conflictFollowUpChanges.apply(conflictSource));
const conflictFollowUpActions = conflictingNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: conflictFollowUp.before, text: conflictFollowUp.after, edit: conflictFollowUp
});
assert.ok(conflictFollowUpActions.some(action => action.type === 'rememberDraft'
  && readDocumentText(action.text ?? '') === 'local\ntwo\nnative'
  && readDocumentText(action.conflictBaseText ?? '') === 'one\ntwo' && action.baseVersion === 4),
  'continued native input after a conflict must retain the original conflict base');
const conflictRevert = documentEdit(ChangeSet.empty(conflictSource.length), conflictSource, conflictSource);
const conflictRevertActions = conflictingNativeProjection.handle({
  type: 'localRecoveryDraftChanged', source: conflictRevert.before, text: conflictRevert.after, edit: conflictRevert
});
assert.ok(conflictRevertActions.some(action => action.type === 'rememberDraft'
  && readDocumentText(action.text ?? '') === 'local\ntwo'
  && readDocumentText(action.conflictBaseText ?? '') === 'one\ntwo'),
  'returning a native value to the conflicting Draft must not silently clear conflict metadata');

console.log('Document Session application contract checks passed');
