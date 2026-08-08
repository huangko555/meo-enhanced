import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createDiffBaselineSelection,
  type DiffBaselineMode,
  type DiffBaselineSelection
} from '../src/application/diffBaselineSelection';
import { createDiffBaselineProtocolAdapter } from '../src/host/diffBaselineProtocolAdapter';

type GitProjection = { readonly oid?: string; readonly available: boolean; readonly reason?: string };

let currentText: string | null = 'current-A';
let recentText: string | null = 'recent-A';
let pinnedText: string | null = null;
let enabled = true;
let ready = true;
let savedUnavailableReason: 'binary' | 'error' | 'no-baseline' | null = null;
const gitForces: boolean[] = [];
let resolveGit: (forceReload: boolean) => Promise<GitProjection> = async () => ({ oid: 'head-A', available: true });
const published: Array<{ selection: DiffBaselineSelection<GitProjection>; generation: number }> = [];
const fixedStates: Array<{ pinned: boolean; active: boolean }> = [];
const refreshes: Array<{ forcePost?: boolean; forceReload?: boolean; delayMs?: number }> = [];
const persistedModes: DiffBaselineMode[] = [];
let warnings = 0;

const selection = createDiffBaselineSelection<GitProjection>({
  initialMode: 'current-edit',
  readEnabled: () => enabled,
  canPublish: () => ready,
  saved: {
    getPinned: () => pinnedText === null ? null : { text: pinnedText },
    pinLatest: async () => {
      if (currentText === null) return null;
      pinnedText = currentText;
      return { text: pinnedText };
    },
    releasePinned: () => { pinnedText = null; },
    resolve: async (mode) => {
      if (savedUnavailableReason) return { ok: false, reason: savedUnavailableReason };
      const text = mode === 'current-edit' ? currentText : (recentText ?? currentText);
      return text === null ? { ok: false, reason: 'no-baseline' } : { ok: true, text };
    }
  },
  git: { resolve: async (forceReload) => { gitForces.push(forceReload); return resolveGit(forceReload); } },
  output: {
    hash: (value) => JSON.stringify(value),
    publish: async (value, generation) => {
      published.push({ selection: value, generation });
      return true;
    },
    publishFixedState: async (state) => { fixedStates.push(state); }
  },
  persistMode: async (mode) => { persistedModes.push(mode); },
  warnNoSavedRevision: () => { warnings += 1; },
  requestRefresh: (options) => { refreshes.push(options); }
});

assert.deepEqual(selection.getState(), {
  mode: 'current-edit',
  fixedPinned: false,
  fixedActive: false
});
assert.equal(await selection.publish(), true);
assert.deepEqual(published.at(-1), {
  selection: { kind: 'saved', mode: 'current-edit', text: 'current-A' },
  generation: 1
});
const firstPublishCount = published.length;
assert.equal(await selection.publish(), true);
assert.equal(published.length, firstPublishCount, 'equal payloads must be deduplicated');
assert.equal(await selection.publish({ forcePost: true }), true);
assert.equal(published.length, firstPublishCount + 1, 'forcePost must bypass payload hash deduplication');
assert.equal(published.at(-1)?.generation, 2);

await selection.setMode('recent-save');
assert.deepEqual(persistedModes, ['recent-save']);
assert.deepEqual(fixedStates.at(-1), { pinned: false, active: false });
assert.deepEqual(refreshes.at(-1), { forcePost: true, forceReload: false });
assert.equal(await selection.publish(), true);
assert.deepEqual(published.at(-1)?.selection, { kind: 'saved', mode: 'recent-save', text: 'recent-A' });

await selection.setMode('git-head');
assert.deepEqual(refreshes.at(-1), { forcePost: true, forceReload: true });
assert.equal(await selection.publish({ forceReload: true }), true);
assert.equal(gitForces.at(-1), true);
assert.deepEqual(published.at(-1)?.selection, {
  kind: 'git-head',
  value: { oid: 'head-A', available: true }
});

await selection.setMode('current-edit');
await selection.setFixed(true);
assert.deepEqual(selection.getState(), {
  mode: 'current-edit',
  fixedPinned: true,
  fixedActive: true
});
assert.equal(await selection.publish(), true);
assert.deepEqual(published.at(-1)?.selection, { kind: 'fixed', text: 'current-A' });
currentText = 'current-B';
assert.equal(await selection.publish({ forcePost: true }), true);
assert.deepEqual(published.at(-1)?.selection, { kind: 'fixed', text: 'current-A' }, 'later saves must not advance fixed');

await selection.setFixed(false);
assert.deepEqual(selection.getState(), {
  mode: 'current-edit',
  fixedPinned: true,
  fixedActive: false
});
await selection.setFixed(true);
assert.equal(await selection.publish(), true);
assert.deepEqual(published.at(-1)?.selection, { kind: 'fixed', text: 'current-A' }, 're-entry must reuse the pinned snapshot');
assert.equal(warnings, 0);

await selection.releaseFixed();
currentText = null;
recentText = null;
savedUnavailableReason = 'binary';
assert.equal(await selection.publish({ forcePost: true }), true);
assert.deepEqual(published.at(-1)?.selection, {
  kind: 'unavailable',
  mode: 'current-edit',
  reason: 'binary'
});
savedUnavailableReason = null;

await selection.setFixed(true);
assert.deepEqual(selection.getState(), {
  mode: 'current-edit',
  fixedPinned: false,
  fixedActive: false
});
assert.equal(warnings, 1, 'pinning without a Saved Revision must keep fixed inactive and warn');

enabled = false;
assert.equal(await selection.publish({ forcePost: true }), true);
assert.deepEqual(published.at(-1)?.selection, { kind: 'disabled' });
enabled = true;

ready = false;
const beforeNotReady = published.length;
assert.equal(await selection.publish({ forcePost: true }), false);
assert.equal(published.length, beforeNotReady, 'Init/ready must precede publication');
ready = true;
assert.equal(await selection.publish({ forcePost: true }), true);

currentText = 'current-C';
selection.savedRevisionChanged();
assert.deepEqual(refreshes.at(-1), { forcePost: true });
await selection.setMode('git-head');
const refreshCountInGitMode = refreshes.length;
selection.savedRevisionChanged();
assert.equal(refreshes.length, refreshCountInGitMode, 'Saved Revision changes must not refresh git-head mode');

let resolveLateGit!: (value: GitProjection) => void;
resolveGit = () => new Promise((resolve) => { resolveLateGit = resolve; });
const beforeLateGit = published.length;
const latePublish = selection.publish({ forceReload: true });
await Promise.resolve();
await selection.setMode('current-edit');
resolveLateGit({ oid: 'stale-head', available: true });
assert.equal(await latePublish, false);
assert.equal(published.length, beforeLateGit, 'a late Git result must not publish after a mode change');
resolveGit = async () => ({ oid: 'head-B', available: true });

let releaseFirstFixedState!: () => void;
let fixedStateCalls = 0;
const transitionRefreshes: Array<{ forcePost?: boolean; forceReload?: boolean }> = [];
const transitionModes: DiffBaselineMode[] = [];
const transitionSelection = createDiffBaselineSelection<GitProjection>({
  initialMode: 'current-edit',
  readEnabled: () => true,
  canPublish: () => true,
  saved: {
    getPinned: () => null,
    pinLatest: async () => null,
    releasePinned: () => undefined,
    resolve: async () => ({ ok: true, text: 'transition' })
  },
  git: { resolve: async () => ({ available: false }) },
  output: {
    hash: (value) => JSON.stringify(value),
    publish: async () => true,
    publishFixedState: async () => {
      fixedStateCalls += 1;
      if (fixedStateCalls === 1) await new Promise<void>((resolve) => { releaseFirstFixedState = resolve; });
    }
  },
  persistMode: async (mode) => { transitionModes.push(mode); },
  warnNoSavedRevision: () => undefined,
  requestRefresh: (options) => { transitionRefreshes.push(options); }
});
const firstModeChange = transitionSelection.setMode('git-head');
await Promise.resolve();
const secondModeChange = transitionSelection.setMode('recent-save');
await secondModeChange;
releaseFirstFixedState();
await firstModeChange;
assert.deepEqual(transitionModes, ['recent-save'], 'a superseded mode change must not persist after the newer choice');
assert.deepEqual(transitionRefreshes, [{ forcePost: true, forceReload: false }]);
assert.equal(transitionSelection.getState().mode, 'recent-save');

currentText = 'retry';
let rejectNextPost = true;
const retrySelection = createDiffBaselineSelection<GitProjection>({
  initialMode: 'current-edit',
  readEnabled: () => true,
  canPublish: () => true,
  saved: {
    getPinned: () => null,
    pinLatest: async () => null,
    releasePinned: () => undefined,
    resolve: async () => ({ ok: true, text: 'retry' })
  },
  git: { resolve: async () => ({ available: false, reason: 'error' }) },
  output: {
    hash: (value) => JSON.stringify(value),
    publish: async (value, generation) => {
      published.push({ selection: value, generation });
      if (rejectNextPost) { rejectNextPost = false; return false; }
      return true;
    },
    publishFixedState: async () => undefined
  },
  persistMode: async () => undefined,
  warnNoSavedRevision: () => undefined,
  requestRefresh: () => undefined
});
const retryStart = published.length;
assert.equal(await retrySelection.publish(), false);
assert.equal(await retrySelection.publish(), true);
assert.equal(published.length, retryStart + 2, 'a failed post must not poison hash deduplication');
assert.deepEqual(published.slice(retryStart).map((entry) => entry.generation), [1, 2]);

let resolveDisposedGit!: (value: GitProjection) => void;
resolveGit = () => new Promise((resolve) => { resolveDisposedGit = resolve; });
await selection.setMode('git-head');
const beforeDispose = published.length;
const disposedPublish = selection.publish();
await Promise.resolve();
selection.dispose();
resolveDisposedGit({ oid: 'after-dispose', available: true });
assert.equal(await disposedPublish, false);
assert.equal(published.length, beforeDispose, 'dispose must ignore late source results');
selection.requestRefresh({ forcePost: true });
assert.equal(refreshes.length, refreshCountInGitMode + 2, 'dispose must reject later refresh requests');

const protocolMessages: unknown[] = [];
const protocolOutput = createDiffBaselineProtocolAdapter({
  readDocumentVersion: () => 17,
  post: async (message) => { protocolMessages.push(message); return true; }
});
await protocolOutput.publish({ kind: 'saved', mode: 'recent-save', text: 'saved' }, 4);
assert.deepEqual(protocolMessages.at(-1), {
  type: 'gitBaselineChanged',
  version: 17,
  payload: {
    available: true,
    tracked: true,
    headOid: null,
    baseText: 'saved',
    mode: 'recent-save',
    generation: 4
  }
});
await protocolOutput.publish({ kind: 'unavailable', mode: 'current-edit', reason: 'binary' }, 5);
assert.deepEqual(protocolMessages.at(-1), {
  type: 'gitBaselineChanged',
  version: 17,
  payload: {
    available: false,
    tracked: false,
    baseText: null,
    mode: 'current-edit',
    reason: 'binary',
    generation: 5
  }
});
await protocolOutput.publish({
  kind: 'git-head',
  value: { available: false, tracked: false, baseText: null, reason: 'not-repo' }
}, 6);
assert.deepEqual(protocolMessages.at(-1), {
  type: 'gitBaselineChanged',
  version: 17,
  payload: {
    available: false,
    tracked: false,
    baseText: null,
    reason: 'not-repo',
    mode: 'git-head',
    generation: 6
  }
});
await protocolOutput.publishFixedState({ pinned: true, active: false });
assert.deepEqual(protocolMessages.at(-1), { type: 'fixedBaselineChanged', pinned: true, active: false });
assert.equal(
  protocolOutput.hash({ kind: 'fixed', text: 'same' }),
  protocolOutput.hash({ kind: 'fixed', text: 'same' }),
  'Protocol hash must be stable and exclude publish generation'
);

const panelSessionSource = readFileSync(new URL('../src/extension/panelSession.ts', import.meta.url), 'utf8');
const extensionSource = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
for (const legacyPattern of [
  /let diffBaselineMode/,
  /let fixedBaselineSelected/,
  /lastSentDiffBaselineHash/,
  /diffBaselineGeneration/,
  /sendGitBaselineChanged/,
  /hashGitBaselinePayload/
]) {
  assert.doesNotMatch(panelSessionSource, legacyPattern, `panelSession must not retain ${legacyPattern.source}`);
}
assert.equal(
  panelSessionSource.match(/createDiffBaselineSelection<GitBaselinePayload>/g)?.length,
  1,
  'panelSession must create exactly one baseline selection owner'
);
assert.equal(
  extensionSource.match(/createDiffBaselineProtocolAdapter\(/g)?.length,
  1,
  'Host Bootstrap must create exactly one baseline Protocol output adapter'
);
assert.match(panelSessionSource, /diffBaselineSelection\.dispose\(\)/);

console.log('diff baseline selection checks passed');
