import assert from 'node:assert/strict';
import { createPendingDraftRecovery } from '../src/application/pendingDraftRecovery';

let current = { version: 1, text: 'base\r\ntext' };
let applyResult = true;
let applyError: Error | null = null;
const applied: Array<{ expected: { version: number; text: string }; draftText: string }> = [];
const copies: string[] = [];

const recovery = createPendingDraftRecovery({
  readCurrentRevision: () => current,
  applyDraft: async (expected, draftText) => {
    applied.push({ expected, draftText });
    if (applyError) throw applyError;
    if (applyResult) current = { version: current.version + 1, text: draftText };
    return applyResult;
  },
  preserveConflict: async copy => {
    const index = copies.push(copy) - 1;
    return { replace: async text => { copies[index] = text; return true; } };
  }
});

const draft = (text: string, baseVersion = current.version) => ({ type: 'draft' as const, baseVersion, text });

assert.equal(await recovery.recover(), false, 'no pending draft must not write');

recovery.remember(draft('base\ntext'), 1);
assert.equal(await recovery.recover(), false, 'newline-equivalent draft must not write');
current = { version: 2, text: 'changed after equivalent draft' };
assert.equal(await recovery.recover(), false, 'equivalent draft must be cleared');

recovery.remember(draft('older draft', 2), 2);
recovery.remember(draft('latest draft', 2), 3);
assert.equal(await recovery.recover(), true, 'latest pending draft must be applied');
assert.deepEqual(applied.at(-1), {
  expected: { version: 2, text: 'changed after equivalent draft' },
  draftText: 'latest draft'
});
assert.equal(await recovery.recover(), false, 'successfully applied draft must be cleared');

recovery.remember(draft('retry after rejection', current.version), 4);
applyResult = false;
assert.equal(await recovery.recover(), false, 'rejected apply must report failure');
applyResult = true;
assert.equal(await recovery.recover(), true, 'rejected draft must remain available for retry');

recovery.remember(draft('retry after error', current.version), 5);
applyError = new Error('apply failed');
await assert.rejects(recovery.recover(), /apply failed/);
applyError = null;
assert.equal(await recovery.recover(), true, 'failed draft must remain available after an exception');

recovery.remember(draft('discarded draft', current.version), 6);
recovery.remember(null, 7);
assert.equal(await recovery.recover(), false, 'null draft must explicitly clear recovery state');

const presentationReceiptVersion = recovery.remember(
  draft('local draft retained until presentation succeeds', current.version),
  8
);
assert.equal(recovery.discardIfCurrent(presentationReceiptVersion), true,
  'the matching successful presentation receipt may clear recovery');
assert.equal(await recovery.recover(), false, 'a successful receipt must clear the discarded draft');

// A newer Host revision may never be overwritten by recovery. The local text
// and both revision contexts instead survive in one untitled conflict copy.
current = { version: 12, text: 'ayc' };
recovery.remember({ type: 'conflict', baseVersion: 10, baseText: 'abc', text: 'axc' }, 9);
assert.equal(await recovery.recover(), true, 'terminal conflict must be preserved without replacing Host');
assert.equal(current.text, 'ayc', 'conflict recovery must not overwrite the newer Host document');
assert.match(copies.at(-1) ?? '', /<<<<<<< MEO local recovery \(base revision 10\)\naxc/);
assert.match(copies.at(-1) ?? '', /\|\|\|\|\|\|\| MEO base\nabc/);
assert.match(copies.at(-1) ?? '', /=======\nayc\n>>>>>>> Host current revision 12/);

// Even a normal candidate becomes a non-destructive copy if its Host base no
// longer exists when close recovery actually runs.
recovery.remember(draft('local after delayed close', 12), 10);
current = { version: 13, text: 'newer Host text' };
assert.equal(await recovery.recover(), true);
assert.equal(current.text, 'newer Host text');
assert.match(copies.at(-1) ?? '', /local after delayed close/);

assert.equal(recovery.remember(draft('current receipt candidate', current.version), 11), 11);
assert.equal(recovery.remember(draft('stale duplicate candidate', current.version), 10), 11);
assert.equal(await recovery.recover(), true);
assert.equal(applied.at(-1)?.draftText, 'current receipt candidate',
  'stale Draft receipts must not replace the latest recovery candidate');

// Dispose has one recovery call. A receipt arriving while its Host apply is
// awaited must be drained by that same call, while concurrent callers share
// the one in-flight operation instead of duplicating recovery effects.
{
  let racingCurrent = { version: 1, text: 'base' };
  let releaseApply: (() => void) | null = null;
  let signalApplyStarted: (() => void) | null = null;
  const applyStarted = new Promise<void>(resolve => { signalApplyStarted = resolve; });
  const applyReleased = new Promise<void>(resolve => { releaseApply = resolve; });
  const racingApplied: string[] = [];
  const racing = createPendingDraftRecovery({
    readCurrentRevision: () => racingCurrent,
    applyDraft: async (_expected, text) => {
      racingApplied.push(text);
      if (racingApplied.length === 1) {
        signalApplyStarted?.();
        await applyReleased;
      }
      racingCurrent = { version: racingCurrent.version + 1, text };
      return true;
    },
    preserveConflict: async () => { throw new Error('base versions are arranged for ordered apply'); }
  });
  racing.remember({ type: 'draft', baseVersion: 1, text: 'first recovery' }, 1);
  const firstRecover = racing.recover();
  const duplicateRecover = racing.recover();
  assert.equal(firstRecover, duplicateRecover, 'concurrent callers must share one recovery drain');
  await applyStarted;
  racing.remember({ type: 'draft', baseVersion: 2, text: 'latest recovery' }, 2);
  releaseApply?.();
  assert.equal(await firstRecover, true);
  assert.deepEqual(racingApplied, ['first recovery', 'latest recovery'],
    'the sole close recovery call must drain the newer receipt to a stable endpoint');
  assert.deepEqual(racingCurrent, { version: 3, text: 'latest recovery' });
}

{
  let conflictCopies = 0;
  let releaseCopy: (() => void) | null = null;
  let signalCopyStarted: (() => void) | null = null;
  const copyStarted = new Promise<void>(resolve => { signalCopyStarted = resolve; });
  const copyReleased = new Promise<void>(resolve => { releaseCopy = resolve; });
  const racingConflict = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 2, text: 'Host text' }),
    applyDraft: async () => { throw new Error('conflict must not apply'); },
    preserveConflict: async () => {
      conflictCopies += 1;
      signalCopyStarted?.();
      await copyReleased;
      return { replace: async () => true };
    }
  });
  racingConflict.remember({ type: 'draft', baseVersion: 1, text: 'local text' }, 1);
  const firstRecover = racingConflict.recover();
  const duplicateRecover = racingConflict.recover();
  await copyStarted;
  releaseCopy?.();
  assert.equal(await firstRecover, true);
  assert.equal(await duplicateRecover, true);
  assert.equal(conflictCopies, 1, 'concurrent recovery must not duplicate an untitled conflict copy');
}

// A normal recovery stays retryable on apply rejection, but a terminal close
// or page-generation handoff has no later retry owner and must preserve the
// candidate in an untitled copy instead of losing it.
{
  const terminalCopies: string[] = [];
  const terminal = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 7, text: 'Host remains' }),
    applyDraft: async () => false,
    preserveConflict: async copy => {
      const index = terminalCopies.push(copy) - 1;
      return { replace: async text => { terminalCopies[index] = text; return true; } };
    }
  });
  terminal.remember({ type: 'draft', baseVersion: 7, text: 'local terminal text' }, 1);
  assert.equal(await terminal.recover(), false, 'ordinary recovery retains a rejected candidate for retry');
  assert.deepEqual(terminalCopies, []);
  assert.equal(await terminal.settleForTermination(), true,
    'terminal recovery falls back to non-destructive preservation after apply rejection');
  assert.match(terminalCopies[0] ?? '', /local terminal text/);
  assert.equal(await terminal.settleForTermination(), false, 'successful terminal preservation clears the candidate');
}

{
  let stillOpen = true;
  const terminalCopies: string[] = [];
  const terminal = createPendingDraftRecovery({
    readCurrentRevision: () => stillOpen ? { version: 8, text: 'before close' } : null,
    applyDraft: async () => {
      stillOpen = false;
      throw new Error('TextDocument closed during WorkspaceEdit');
    },
    preserveConflict: async copy => {
      const index = terminalCopies.push(copy) - 1;
      return { replace: async text => { terminalCopies[index] = text; return true; } };
    }
  });
  terminal.remember({ type: 'draft', baseVersion: 8, text: 'last local text' }, 1);
  assert.equal(await terminal.settleForTermination(), true,
    'terminal settlement falls back when the original document closes during apply');
  assert.match(terminalCopies[0] ?? '', /Host document unavailable/);
  assert.match(terminalCopies[0] ?? '', /last local text/);
}

// A newer receipt can arrive after the preservation operation has started.
// That drain must update its one owned artifact instead of opening old/new
// copies, while concurrent callers continue to share the same operation.
{
  const artifacts: string[] = [];
  let started!: () => void, release!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const coalesced = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 2, text: 'Host remains' }),
    applyDraft: async () => { throw new Error('conflict never replaces Host'); },
    preserveConflict: async text => {
      const index = artifacts.push(text) - 1;
      started();
      await released;
      return { replace: async (next: string) => { artifacts[index] = next; return true; } };
    }
  });
  coalesced.remember({ type: 'draft', baseVersion: 1, text: 'older local' }, 1);
  const draining = coalesced.settleForTermination();
  await opening;
  coalesced.remember({ type: 'draft', baseVersion: 1, text: 'newest local' }, 2);
  release();
  assert.equal(await draining, true);
  assert.equal(artifacts.length, 1, 'one drain creates only one recovery artifact');
  assert.match(artifacts[0]!, /newest local/);
  assert.doesNotMatch(artifacts[0]!, /older local/);
  assert.equal(coalesced.hasPending(), false);
}

console.log('Pending Draft recovery checks passed');
