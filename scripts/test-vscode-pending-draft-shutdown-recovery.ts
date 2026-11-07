import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spyOn } from 'bun:test';
import { createPendingDraftRecovery, type PendingDraftRecovery } from '../src/application/pendingDraftRecovery';
import { createPendingDraftShutdownRecovery, createVscodePendingDraftShutdownRecovery, type PendingDraftShutdownStore } from '../src/host/vscodePendingDraftShutdownRecovery';

let stored: readonly string[] | null = [];
const store: PendingDraftShutdownStore = {
  read: () => stored,
  write: copies => { stored = [...copies]; }
};

{
  let current = { version: 4, text: 'Host text' };
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => current,
    applyDraft: async () => false,
    preserveConflict: async () => false
  });
  const opened: string[] = [];
  const shutdown = createPendingDraftShutdownRecovery({
    store,
    openRecoveryCopy: async text => { opened.push(text); }
  });
  shutdown.watch(recovery);

  recovery.remember({ type: 'draft', baseVersion: 4, text: 'local pending text' }, 1, {
    ownerId: 'page-1', receiptVersion: 1
  });
  assert.deepEqual(stored, [], 'typing only updates the in-memory recovery owner');
  shutdown.persistForShutdown();
  assert.equal(stored?.length, 1, 'normal shutdown must persist a pending native candidate once');
  assert.match(stored?.[0] ?? '', /local pending text/);
  assert.match(stored?.[0] ?? '', /<<<<<<< MEO local recovery/);

  await shutdown.restore();
  assert.equal(opened.length, 1, 'startup must open one independent recovery copy');
  assert.match(opened[0]!, /local pending text/);
  assert.match(opened[0]!, /Host text/);
  assert.deepEqual(stored, [], 'only a successfully opened copy clears its stored artifact');

  recovery.remember({ type: 'draft', baseVersion: 4, text: 'accepted Host text' }, 2, {
    ownerId: 'page-1', receiptVersion: 2
  });
  current = { version: 5, text: 'accepted Host text' };
  shutdown.persistForShutdown();
  assert.deepEqual(stored, [],
    'a pending candidate already equal to the current Host document must not create a duplicate restart copy');

  stored = ['prior failed recovery'];
  const failing = createPendingDraftShutdownRecovery({
    store,
    openRecoveryCopy: async () => { throw new Error('simulated open failure'); }
  });
  await failing.restore();
  assert.match(stored?.[0] ?? '', /prior failed recovery/,
    'a failed startup recovery must retain its evidence for the next launch');

  const next = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 1, text: 'original stays unchanged' }),
    applyDraft: async () => false,
    preserveConflict: async () => false
  });
  const preserving = createPendingDraftShutdownRecovery({ store, openRecoveryCopy: async () => undefined });
  preserving.watch(next);
  next.remember({ type: 'draft', baseVersion: 1, text: 'new shutdown candidate' }, 1);
  preserving.persistForShutdown();
  const combined = stored?.join('\n') ?? '';
  assert.match(combined, /prior failed recovery/);
  assert.match(combined, /new shutdown candidate/,
    'a shutdown during failed-startup recovery must retain both old and newly captured candidates');

  const recovered: string[] = [];
  const finalRestore = createPendingDraftShutdownRecovery({
    store,
    openRecoveryCopy: async text => { recovered.push(text); }
  });
  await finalRestore.restore();
  assert.equal(recovered.length, 2);
  assert.deepEqual(stored, []);
}

{
  let pending = false;
  let captures = 0;
  const listeners = new Set<() => void>();
  const budgetRecovery: PendingDraftRecovery = {
    remember: () => 0,
    discardIfCurrent: () => false,
    hasPending: () => pending,
    recover: async () => false,
    settleForTermination: async () => false,
    preserveRetired: async () => false,
    captureForRestart: () => { captures += 1; return pending ? ['budget recovery copy'] : []; },
    onDidChangePending(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    }
  };
  stored = [];
  const budget = createPendingDraftShutdownRecovery({ store, openRecoveryCopy: async () => undefined });
  budget.watch(budgetRecovery);
  for (let index = 0; index < 32; index++) {
    pending = true;
    for (const listener of listeners) listener();
  }
  assert.equal(captures, 0, 'recovery registration must not serialize a full copy for each native input');
  budget.persistForShutdown();
  assert.equal(captures, 1, 'normal shutdown is the first point that serializes the recovery copy');
}

{
  stored = ['older startup recovery'];
  const arriving = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 1, text: 'Host remains' }),
    applyDraft: async () => false,
    preserveConflict: async () => false
  });
  const shutdown = createPendingDraftShutdownRecovery({ store, openRecoveryCopy: async () => undefined });
  shutdown.watch(arriving);
  const restoring = createPendingDraftShutdownRecovery({
    store,
    openRecoveryCopy: async () => {
      arriving.remember({ type: 'draft', baseVersion: 1, text: 'new shutdown during restore' }, 1);
      shutdown.persistForShutdown();
    }
  });
  await restoring.restore();
  assert.deepEqual(stored?.length, 1);
  assert.match(stored?.[0] ?? '', /new shutdown during restore/,
    'startup cleanup must not overwrite a shutdown candidate captured while it was opening an older recovery copy');
}

for (const mode of ['applied', 'same-host', 'discard-in-flight'] as const) {
  stored = [];
  let current = { version: 1, text: 'original' };
  let finish!: (result: boolean) => void;
  const blocked = new Promise<boolean>(resolve => { finish = resolve; });
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => current,
    applyDraft: async () => {
      if (mode === 'discard-in-flight') return blocked;
      current = { version: 2, text: 'pending' };
      return true;
    }, preserveConflict: async () => false
  });
  let captures = 0;
  const capture = recovery.captureForRestart;
  recovery.captureForRestart = () => { captures++; return capture(); };
  const shutdown = createPendingDraftShutdownRecovery({ store, openRecoveryCopy: async () => undefined });
  shutdown.watch(recovery);
  recovery.remember({ type: 'draft', baseVersion: 1, text: 'pending' }, 1);
  if (mode === 'same-host') current = { version: 2, text: 'pending' };
  const settling = recovery.recover();
  if (mode === 'discard-in-flight') {
    await Promise.resolve();
    assert.equal(recovery.discardIfCurrent(1), true);
    finish(false);
  }
  await settling;
  assert.equal(recovery.hasPending(), false);
  shutdown.persistForShutdown();
  assert.equal(captures, 0, `${mode}: settled owners must leave the shutdown registry`);
}

const temporaryRoot = path.resolve(import.meta.dir, '../.local');
fs.mkdirSync(temporaryRoot, { recursive: true });
for (const mode of ['temporary-only', 'both', 'corrupt-main', 'unreadable-main', 'rename-failure', 'cleanup-failure'] as const) {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'shutdown-store-'));
  try {
    const main = path.join(directory, 'pending-draft-recovery.json');
    const encode = (copies: string[]) => JSON.stringify({ schemaVersion: 1, copies });
    if (mode === 'both' || mode === 'unreadable-main') fs.writeFileSync(main, encode(['older complete copy']));
    if (mode === 'corrupt-main') fs.writeFileSync(main, 'partial invalid JSON');
    if (mode !== 'rename-failure') fs.writeFileSync(main + '.next', encode(['latest complete copy']));
    const opened: string[] = [];
    const create = () => createVscodePendingDraftShutdownRecovery({
      storageDirectory: directory, openRecoveryCopy: async text => { opened.push(text); }
    });
    if (mode === 'rename-failure') {
      const shutdown = create();
      const recovery = createPendingDraftRecovery({
        readCurrentRevision: () => ({ version: 1, text: 'original' }),
        applyDraft: async () => false, preserveConflict: async () => false
      });
      shutdown.watch(recovery);
      recovery.remember({ type: 'draft', baseVersion: 1, text: 'input before failed rename' }, 1);
      const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated rename lock'); });
      try { shutdown.persistForShutdown(); } finally { rename.mockRestore(); }
      assert.ok(fs.readdirSync(directory).some(name => name.endsWith('.next')),
        'Failed atomic rename must leave complete temporary evidence');
      await create().restore();
      assert.ok(opened.some(copy => copy.includes('input before failed rename')),
        'A subsequent launch must recover the complete temporary file after rename failure');
    } else {
      if (mode === 'unreadable-main') {
        const shutdown = create();
        const recovery = createPendingDraftRecovery({
          readCurrentRevision: () => null, applyDraft: async () => false, preserveConflict: async () => false
        });
        shutdown.watch(recovery);
        recovery.remember({ type: 'draft', baseVersion: 1, text: 'new input beside unreadable evidence' }, 1);
        const read = fs.readFileSync;
        const locked = spyOn(fs, 'readFileSync').mockImplementation((...args: any[]) => {
          if (args[0] === main) throw Object.assign(new Error('simulated read lock'), { code: 'EACCES' });
          return Reflect.apply(read, fs, args);
        });
        try { shutdown.persistForShutdown(); } finally { locked.mockRestore(); }
      }
      if (mode === 'cleanup-failure') {
        const remove = spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('simulated cleanup lock'); });
        try { await create().restore(); } finally { remove.mockRestore(); }
        assert.ok(fs.readdirSync(directory).some(name => name.endsWith('.next')),
          'Cleanup failure must retain complete evidence');
      }
      await create().restore();
      assert.ok(opened.includes('latest complete copy'), `${mode}: valid temporary evidence must be recovered`);
      if (mode === 'cleanup-failure') assert.equal(opened.length, 2,
        'A retained consumed copy may be offered again after failed cleanup');
      if (mode === 'both') assert.ok(opened.includes('older complete copy'));
      if (mode === 'unreadable-main') {
        assert.ok(opened.includes('older complete copy'));
        assert.ok(opened.some(copy => copy.includes('new input beside unreadable evidence')));
      }
      if (mode === 'corrupt-main') {
        assert.equal(fs.readFileSync(main, 'utf8'), 'partial invalid JSON', 'Invalid original evidence must remain untouched');
        const shutdown = create();
        const recovery = createPendingDraftRecovery({
          readCurrentRevision: () => null, applyDraft: async () => false, preserveConflict: async () => false
        });
        shutdown.watch(recovery);
        recovery.remember({ type: 'draft', baseVersion: 1, text: 'new input beside corrupt evidence' }, 1);
        shutdown.persistForShutdown();
        await create().restore();
        assert.ok(opened.some(copy => copy.includes('new input beside corrupt evidence')));
      }
    }
  } finally {
    if (!path.resolve(directory).startsWith(temporaryRoot + path.sep)) throw new Error('Refuse cleanup outside owned test root');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

console.log('VS Code pending Draft shutdown recovery checks passed');
