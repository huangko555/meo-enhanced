import assert from 'node:assert/strict';
import { createPendingDraftRecovery } from '../src/application/pendingDraftRecovery';

let currentText = 'base\r\ntext';
let applyResult = true;
let applyError: Error | null = null;
const applied: Array<{ currentText: string; draftText: string }> = [];

const recovery = createPendingDraftRecovery({
  readCurrentText: () => currentText,
  applyDraft: async (expectedCurrentText, draftText) => {
    applied.push({ currentText: expectedCurrentText, draftText });
    if (applyError) throw applyError;
    if (applyResult) currentText = draftText;
    return applyResult;
  }
});

assert.equal(await recovery.recover(), false, 'no pending draft must not write');

recovery.remember('base\ntext');
assert.equal(await recovery.recover(), false, 'newline-equivalent draft must not write');
currentText = 'changed after equivalent draft';
assert.equal(await recovery.recover(), false, 'equivalent draft must be cleared');

recovery.remember('older draft');
recovery.remember('latest draft');
assert.equal(await recovery.recover(), true, 'latest pending draft must be applied');
assert.deepEqual(applied.at(-1), {
  currentText: 'changed after equivalent draft',
  draftText: 'latest draft'
});
assert.equal(await recovery.recover(), false, 'successfully applied draft must be cleared');

recovery.remember('retry after rejection');
applyResult = false;
assert.equal(await recovery.recover(), false, 'rejected apply must report failure');
applyResult = true;
assert.equal(await recovery.recover(), true, 'rejected draft must remain available for retry');

recovery.remember('retry after error');
applyError = new Error('apply failed');
await assert.rejects(recovery.recover(), /apply failed/);
applyError = null;
assert.equal(await recovery.recover(), true, 'failed draft must remain available after an exception');

recovery.remember('discarded draft');
recovery.remember(null);
assert.equal(await recovery.recover(), false, 'null draft must explicitly clear recovery state');

const presentationReceiptVersion = recovery.remember('local draft retained until presentation succeeds');
assert.equal(
  recovery.discardIfCurrent(presentationReceiptVersion),
  true,
  'the matching successful presentation receipt may clear recovery'
);
assert.equal(await recovery.recover(), false, 'a successful receipt must clear the discarded draft');

const failedPresentationReceiptVersion = recovery.remember('local draft retained after presentation failure');
assert.equal(
  recovery.discardIfCurrent(failedPresentationReceiptVersion - 1),
  false,
  'a failed or stale presentation receipt must not clear recovery'
);
assert.equal(
  await recovery.recover(),
  true,
  'the original discarded local draft must remain recoverable after presentation failure'
);

console.log('Pending Draft recovery checks passed');
