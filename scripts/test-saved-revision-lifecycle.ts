import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';
import {
  createSavedRevisionLifecycle,
  type SavedRevisionFileAdapter,
  type SavedRevisionFileReadResult,
  type SavedRevisionRefreshTimer
} from '../src/application/savedRevisionLifecycle';

let vscodeRead: () => Promise<Uint8Array> = async () => new Uint8Array();
mock.module('vscode', () => ({
  workspace: { fs: { readFile: () => vscodeRead() } }
}));
const { createVscodeSavedRevisionFileAdapter } = await import('../src/host/vscodeSavedRevisionFileAdapter');

const nonFile = createVscodeSavedRevisionFileAdapter({ scheme: 'untitled' } as never);
assert.deepEqual(await nonFile.read(), { ok: false, reason: 'not-file' });

const file = createVscodeSavedRevisionFileAdapter({ scheme: 'file' } as never);
vscodeRead = async () => new Uint8Array(1024 * 1024 + 1);
assert.deepEqual(await file.read(), { ok: false, reason: 'too-large' });
vscodeRead = async () => new Uint8Array([65, 0, 66]);
assert.deepEqual(await file.read(), { ok: false, reason: 'binary' });
vscodeRead = async () => new TextEncoder().encode('\ufeffsaved');
assert.deepEqual(await file.read(), { ok: true, text: 'saved' });
vscodeRead = async () => { throw new Error('read failed'); };
assert.deepEqual(await file.read(), { ok: false, reason: 'error' });

type Scheduled = { cancelled: boolean; delayMs: number; run: () => void };
const scheduled: Scheduled[] = [];
const timer: SavedRevisionRefreshTimer = {
  schedule(delayMs, run) {
    const task = { cancelled: false, delayMs, run };
    scheduled.push(task);
    return { cancel: () => { task.cancelled = true; } };
  }
};

const reads: Array<() => Promise<SavedRevisionFileReadResult>> = [];
const observations: SavedRevisionFileReadResult[] = [];
let documentRevision = { version: 7, text: 'disk' };
let saveAccepted = true;
const lifecycle = createSavedRevisionLifecycle({
  file: { read: () => reads.shift()?.() ?? Promise.resolve({ ok: false, reason: 'error' }) },
  timer,
  readDocumentRevision: () => documentRevision,
  saveDocument: async () => saveAccepted,
  onRefresh: async (observation) => { observations.push(observation.result); }
});

reads.push(async () => ({ ok: true, text: 'disk' }));
assert.deepEqual(await lifecycle.readInitial(), { text: 'disk', version: 7 });
documentRevision = { version: 8, text: 'edited' };
reads.push(async () => ({ ok: true, text: 'disk' }));
assert.deepEqual(await lifecycle.readInitial(), { text: 'disk', version: null });

let resolveFirst!: (value: SavedRevisionFileReadResult) => void;
reads.push(() => new Promise((resolve) => { resolveFirst = resolve; }));
reads.push(async () => ({ ok: true, text: 'newest' }));
void lifecycle.refreshNow();
await Promise.resolve();
void lifecycle.refreshNow();
resolveFirst({ ok: true, text: 'stale' });
for (let index = 0; index < 8; index += 1) await Promise.resolve();
assert.deepEqual(observations, [{ ok: true, text: 'newest' }], 'late generation must be ignored');

lifecycle.scheduleRefresh(150);
lifecycle.scheduleRefresh(150);
assert.equal(scheduled.at(-2)?.cancelled, true, 'watcher refresh must replace the older timer');
assert.equal(scheduled.at(-1)?.delayMs, 150, 'watcher refresh must preserve the requested delay');
reads.push(async () => ({ ok: false, reason: 'binary' }));
scheduled.at(-1)?.run();
for (let index = 0; index < 8; index += 1) await Promise.resolve();
assert.deepEqual(observations.at(-1), { ok: false, reason: 'binary' });

const saveTrace: string[] = [];
const explicitFile: SavedRevisionFileAdapter = {
  read: async () => { saveTrace.push('read'); return { ok: true, text: 'saved text' }; }
};
const explicit = createSavedRevisionLifecycle({
  file: explicitFile,
  timer,
  readDocumentRevision: () => ({ version: 1, text: 'saved text' }),
  saveDocument: async () => { saveTrace.push('save'); return true; },
  onRefresh: async () => undefined
});
assert.deepEqual(await explicit.saveAndReadBack('saved text'), { ok: true, text: 'saved text' });
assert.deepEqual(saveTrace, ['save', 'read'], 'explicit save must complete before read-back');
const mismatch = createSavedRevisionLifecycle({
  file: { read: async () => ({ ok: true, text: 'different' }) },
  timer,
  readDocumentRevision: () => ({ version: 1, text: 'expected' }),
  saveDocument: async () => true,
  onRefresh: async () => undefined
});
assert.deepEqual(await mismatch.saveAndReadBack('expected'), { ok: false, reason: 'text-mismatch' });
saveAccepted = false;
assert.deepEqual(await lifecycle.saveAndReadBack('ignored'), { ok: false, reason: 'save-rejected' });

lifecycle.scheduleRefresh(150);
const disposeTimer = scheduled.at(-1);
lifecycle.dispose();
assert.equal(disposeTimer?.cancelled, true);
disposeTimer?.run();
for (let index = 0; index < 4; index += 1) await Promise.resolve();
assert.notDeepEqual(observations.at(-1), { ok: true, text: 'after-dispose' });

let resolveLate!: (value: SavedRevisionFileReadResult) => void;
const lateObservations: SavedRevisionFileReadResult[] = [];
const late = createSavedRevisionLifecycle({
  file: { read: () => new Promise((resolve) => { resolveLate = resolve; }) },
  timer,
  readDocumentRevision: () => ({ version: 1, text: 'old' }),
  saveDocument: async () => true,
  onRefresh: async (observation) => { lateObservations.push(observation.result); }
});
void late.refreshNow();
await Promise.resolve();
late.dispose();
resolveLate({ ok: true, text: 'late' });
for (let index = 0; index < 4; index += 1) await Promise.resolve();
assert.deepEqual(lateObservations, [], 'dispose must ignore an in-flight read result');

const repoRoot = path.resolve(import.meta.dir, '..');
const panelSession = fs.readFileSync(path.join(repoRoot, 'src/extension/panelSession.ts'), 'utf8');
const hostBootstrap = fs.readFileSync(path.join(repoRoot, 'src/extension.ts'), 'utf8');
for (const legacyIdentifier of [
  'readSavedDiskText',
  'savedRevisionReadPromise',
  'savedRevisionRefreshPending',
  'pendingSavedRevisionTimer',
  'savedRevisionInitialized',
  'savedRevisionUnavailableReason',
  'SAVED_REVISION_MAX_BYTES'
]) {
  assert.equal(panelSession.includes(legacyIdentifier), false, `Legacy Saved Revision state returned: ${legacyIdentifier}`);
}
assert.equal((panelSession.match(/createSavedRevisionLifecycle\s*\(/g) ?? []).length, 1);
assert.equal((hostBootstrap.match(/createVscodeSavedRevisionFileAdapter\s*\(/g) ?? []).length, 1);
assert.equal((hostBootstrap.match(/createSavedRevisionRefreshTimerAdapter\s*\(/g) ?? []).length, 1);
assert.match(panelSession, /savedRevisionLifecycle\.dispose\(\)/);

console.log('Saved Revision lifecycle checks passed');
