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

// Active and retired candidates are one settlement owner. A same-receipt
// terminal packet strengthens the active candidate instead of racing it with
// an unnecessary untitled copy.
{
  const copies: string[] = [];
  const applied: string[] = [];
  const origin = { ownerId: 'page-A', receiptVersion: 1 };
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 1, text: 'Host text' }),
    applyDraft: async (_expected, text) => { applied.push(text); return true; },
    preserveConflict: async text => { copies.push(text); return { replace: async () => true }; }
  });
  const candidate = { type: 'draft' as const, baseVersion: 1, text: 'same handoff text' };
  coordinated.remember(candidate, 1, origin);
  const active = coordinated.settleForTermination();
  const retired = coordinated.preserveRetired(candidate, origin);
  assert.deepEqual(await Promise.all([active, retired]), [true, true]);
  assert.deepEqual(applied, ['same handoff text']);
  assert.deepEqual(copies, [], 'same receipt must not open a competing retired copy');
}

// A newer terminal handoff wins before an older active candidate can write
// Host; older/equal late terminal packets are settled by the same tombstone.
{
  const copies: string[] = [];
  let applies = 0;
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 1, text: 'Host text' }),
    applyDraft: async () => { applies += 1; return true; },
    preserveConflict: async text => { copies.push(text); return { replace: async next => { copies[0] = next; return true; } }; }
  });
  coordinated.remember({ type: 'draft', baseVersion: 1, text: 'old active' }, 1, { ownerId: 'page-A', receiptVersion: 1 });
  const active = coordinated.settleForTermination();
  const newest = coordinated.preserveRetired(
    { type: 'draft', baseVersion: 1, text: 'new terminal' },
    { ownerId: 'page-A', receiptVersion: 2 }
  );
  assert.deepEqual(await Promise.all([active, newest]), [false, true]);
  assert.equal(applies, 0, 'superseded active receipt must never write Host');
  assert.equal(copies.length, 1);
  assert.match(copies[0]!, /new terminal/);
  assert.equal(await coordinated.preserveRetired(
    { type: 'draft', baseVersion: 1, text: 'late old terminal' },
    { ownerId: 'page-A', receiptVersion: 1 }
  ), true);
  assert.equal(copies.length, 1, 'lower terminal receipt must use the settled tombstone');
}

// Artifact capability belongs to a handoff scope. A newer same-scope terminal
// packet may update it, whereas another scope receives an independent copy.
{
  const copies: string[] = [];
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 4, text: 'Host text' }),
    applyDraft: async () => { throw new Error('retired candidates never apply'); },
    preserveConflict: async text => {
      const index = copies.push(text) - 1;
      return { replace: async next => { copies[index] = next; return true; } };
    }
  });
  await coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'A one' }, { ownerId: 'A', receiptVersion: 1 });
  await coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'A two' }, { ownerId: 'A', receiptVersion: 2 });
  await coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'B one' }, { ownerId: 'B', receiptVersion: 1 });
  assert.equal(copies.length, 2);
  assert.match(copies[0]!, /A two/);
  assert.match(copies[1]!, /B one/);
}

// If a released recovery buffer is no longer writable, the newest candidate
// is copied separately; an update failure never overwrites user-owned text.
{
  const copies: string[] = [];
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 4, text: 'Host text' }),
    applyDraft: async () => false,
    preserveConflict: async text => {
      const index = copies.push(text) - 1;
      return { replace: async () => { if (index === 0) throw new Error('copy closed'); return true; } };
    }
  });
  await coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'first protected' }, { ownerId: 'A', receiptVersion: 1 });
  await coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'latest protected' }, { ownerId: 'A', receiptVersion: 2 });
  assert.equal(copies.length, 2);
  assert.match(copies[0]!, /first protected/);
  assert.match(copies[1]!, /latest protected/);
}

// Replacing an unstarted retired job does not falsely settle the older
// receipt. Both callers receive the actual failure of the surviving job.
{
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 4, text: 'Host text' }),
    applyDraft: async () => false,
    preserveConflict: async () => false
  });
  const old = coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'older' }, { ownerId: 'A', receiptVersion: 1 });
  const newest = coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'newest' }, { ownerId: 'A', receiptVersion: 2 });
  assert.deepEqual(await Promise.all([old, newest]), [false, false], 'superseded waiters must wait for durable newest preservation');
}

// An unscoped active settlement cannot swallow an unrelated retired
// candidate. Independent retired calls never inherit active settlement or write Host.
{
  const copies: string[] = [];
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 1, text: 'Host text' }),
    applyDraft: async () => true,
    preserveConflict: async text => { copies.push(text); return { replace: async () => true }; }
  });
  coordinated.remember({ type: 'draft', baseVersion: 1, text: 'active text' }, 1);
  assert.equal(await coordinated.recover(), true);
  assert.equal(await coordinated.preserveRetired({ type: 'draft', baseVersion: 1, text: 'independent retired text' }), true);
  assert.equal(copies.length, 1);
  assert.match(copies[0]!, /independent retired text/);
}

// An equivalent same-receipt terminal packet is settled even when the active
// call reports no Host mutation because the text was already current.
{
  const origin = { ownerId: 'A', receiptVersion: 1 };
  const candidate = { type: 'draft' as const, baseVersion: 1, text: 'already current' };
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 1, text: 'already current' }),
    applyDraft: async () => { throw new Error('equivalence must not write'); },
    preserveConflict: async () => { throw new Error('equivalence must not copy'); }
  });
  coordinated.remember(candidate, 1, origin);
  assert.deepEqual(await Promise.all([
    coordinated.settleForTermination(),
    coordinated.preserveRetired(candidate, origin)
  ]), [false, true]);
}

// A completion callback may enqueue recovery precisely as an empty drain is
// releasing its latch. The queue must restart and settle that late work.
{
  const copies: string[] = [];
  const coordinated = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 9, text: 'Host text' }),
    applyDraft: async () => false,
    preserveConflict: async text => { copies.push(text); return { replace: async () => true }; }
  });
  const noWork = coordinated.settleForTermination();
  const late = noWork.then(() => coordinated.preserveRetired(
    { type: 'draft', baseVersion: 1, text: 'late queue wakeup' }, { ownerId: 'late', receiptVersion: 1 }
  ));
  assert.equal(await late, true);
  assert.equal(copies.length, 1);
}

// Unscoped candidates have no shared receipt identity. Their text must not be
// concatenated into an ambiguous metadata key (or retained there at full size).
{
  const copies: string[] = [];
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => null, applyDraft: async () => false,
    preserveConflict: async text => { copies.push(text); return { replace: async () => true }; }
  });
  await recovery.preserveRetired({ type: 'conflict', baseVersion: 1, baseText: 'left:middle', text: 'right' });
  await recovery.preserveRetired({ type: 'conflict', baseVersion: 1, baseText: 'left', text: 'middle:right' });
  assert.equal(copies.length, 2, 'independent unscoped candidates must not collide');
}

// A confirmed clear is a settlement, including a matching explicit discard
// when there is no remaining active candidate. Older terminal packets cannot
// resurrect text after that acknowledgement.
{
  const copies: string[] = [];
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 4, text: 'new Host text' }), applyDraft: async () => false,
    preserveConflict: async text => { copies.push(text); return { replace: async () => true }; }
  });
  recovery.remember({ type: 'draft', baseVersion: 1, text: 'acknowledged draft' }, 1, { ownerId: 'A', receiptVersion: 1 });
  recovery.remember(null, 2, { ownerId: 'A', receiptVersion: 2 });
  assert.equal(recovery.discardIfCurrent(2), true);
  assert.equal(await recovery.preserveRetired({ type: 'draft', baseVersion: 1, text: 'acknowledged draft' },
    { ownerId: 'A', receiptVersion: 1 }), true);
  assert.deepEqual(copies, []);
}

// The artifact stays pinned through its settlement, including the microtask
// between the preservation port resolving and the public receipt being marked.
{
  const copies: string[] = [];
  let open!: () => void, release!: () => void;
  const updating = new Promise<void>(resolve => { open = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let updates = 0;
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => null, applyDraft: async () => false,
    preserveConflict: async text => {
      const index = copies.push(text) - 1;
      return { replace: async text => {
        if (++updates === 1) { open(); await released; }
        copies[index] = text; return true;
      } };
    }
  });
  await recovery.preserveRetired({ type: 'draft', baseVersion: 1, text: 'A first' }, { ownerId: 'A', receiptVersion: 1 });
  const pending = recovery.preserveRetired({ type: 'draft', baseVersion: 1, text: 'A second' }, { ownerId: 'A', receiptVersion: 2 });
  await updating;
  release();
  queueMicrotask(() => {
    for (let index = 0; index < 24; index++) {
      const origin = { ownerId: `other-${index}`, receiptVersion: 1 };
      recovery.remember(null, index + 1, origin);
    }
  });
  assert.equal(await pending, true);
  await recovery.preserveRetired({ type: 'draft', baseVersion: 1, text: 'A latest' }, { ownerId: 'A', receiptVersion: 3 });
  assert.equal(copies.length, 1, 'scope churn must not lose a capability before its settlement finishes');
  assert.match(copies[0]!, /A latest/);
}

// Terminal packets arriving during real port I/O cannot race the active
// operation. Re-read Host equivalence after apply; reuse a copy after preserve.
for (const sink of ['apply', 'preserve'] as const) for (const newer of [false, true]) {
  let current = { version: 1, text: 'Host unchanged' };
  const copies: string[] = [];
  let started!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => current,
    applyDraft: async (_expected, text) => {
      assert.equal(sink, 'apply'); started(); await released;
      current = { version: 2, text }; return true;
    },
    preserveConflict: async text => {
      const index = copies.push(text) - 1;
      if (sink === 'preserve' && index === 0) { started(); await released; }
      return { replace: async next => { copies[index] = next; return true; } };
    }
  });
  const candidate = sink === 'apply'
    ? { type: 'draft' as const, baseVersion: 1, text: 'active local' }
    : { type: 'conflict' as const, baseVersion: 1, baseText: 'base', text: 'active local' };
  recovery.remember(candidate, 1, { ownerId: 'A', receiptVersion: 1 });
  const active = recovery.settleForTermination();
  await entering;
  const retired = recovery.preserveRetired(newer ? { ...candidate, text: 'latest local' } : candidate,
    { ownerId: 'A', receiptVersion: newer ? 2 : 1 });
  release();
  assert.deepEqual(await Promise.all([active, retired]), [true, true]);
  assert.equal(current.text, sink === 'apply' ? 'active local' : 'Host unchanged', 'retired input never writes Host');
  assert.equal(copies.length, sink === 'apply' && !newer ? 0 : 1);
  if (copies.length) assert.match(copies[0]!, newer ? /latest local/ : /active local/);
}

// A retired receipt that settles first makes a lower active receipt inert,
// including when the active request was enqueued during preservation I/O.
{
  const copies: string[] = [];
  let started!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 1, text: 'Host unchanged' }),
    applyDraft: async () => { throw new Error('an older active receipt must not write'); },
    preserveConflict: async text => {
      copies.push(text); started(); await released; return { replace: async () => true };
    }
  });
  const retired = recovery.preserveRetired({ type: 'draft', baseVersion: 1, text: 'newest retired' }, { ownerId: 'A', receiptVersion: 2 });
  await entering;
  recovery.remember({ type: 'draft', baseVersion: 1, text: 'older active' }, 1, { ownerId: 'A', receiptVersion: 1 });
  const active = recovery.settleForTermination();
  release();
  assert.deepEqual(await Promise.all([retired, active]), [true, false]);
  assert.equal(copies.length, 1); assert.match(copies[0]!, /newest retired/);
}

console.log('Pending Draft recovery checks passed');
