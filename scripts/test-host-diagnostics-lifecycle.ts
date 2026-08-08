import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createHostDiagnosticsLifecycle,
  type HostDiagnosticsRuntime,
  type HostDiagnosticsTimer
} from '../src/application/hostDiagnosticsLifecycle';

type Scheduled = { readonly delayMs: number; cancelled: boolean; readonly run: () => void };

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const scheduled: Scheduled[] = [];
const timer: HostDiagnosticsTimer = {
  schedule(delayMs, run) {
    const task = { delayMs, cancelled: false, run };
    scheduled.push(task);
    return { cancel: () => { task.cancelled = true; } };
  }
};

const computations: Array<() => Promise<readonly string[]>> = [];
const replacements: Array<readonly string[]> = [];
const trace: string[] = [];
let enabled = true;
let external = false;
let clears = 0;
let publishes = 0;
let failures = 0;
const runtime: HostDiagnosticsRuntime<string> = {
  computeInternal: (currentEnabled) => {
    trace.push(`compute:${currentEnabled}`);
    return computations.shift()?.() ?? Promise.resolve([]);
  },
  hasExternal: () => external,
  replaceInternal: (diagnostics) => { replacements.push(diagnostics); },
  clearInternal: () => { clears += 1; }
};
const lifecycle = createHostDiagnosticsLifecycle({
  runtime,
  timer,
  readEnabled: () => enabled,
  publishCombined: async () => { publishes += 1; },
  reportFailure: () => { failures += 1; }
});

lifecycle.requestRefresh();
lifecycle.requestRefresh();
assert.equal(scheduled.at(-2)?.cancelled, true, 'continuous input must replace the older debounce');
assert.equal(scheduled.at(-1)?.delayMs, 350);
computations.push(async () => ['latest-input']);
scheduled.at(-1)?.run();
await flushPromises();
assert.deepEqual(replacements, [['latest-input']]);

enabled = false;
lifecycle.requestRefresh(0);
assert.equal(scheduled.at(-1)?.delayMs, 0, 'configuration refresh must be immediate');
computations.push(async () => []);
scheduled.at(-1)?.run();
await flushPromises();
assert.equal(trace.at(-1), 'compute:false');
assert.deepEqual(replacements.at(-1), [], 'empty results must clear through the normal replacement path');

let resolveStale!: (value: readonly string[]) => void;
computations.push(() => new Promise((resolve) => { resolveStale = resolve; }));
lifecycle.requestRefresh(0);
scheduled.at(-1)?.run();
await Promise.resolve();
computations.push(async () => ['new-generation']);
lifecycle.requestRefresh(0);
scheduled.at(-1)?.run();
resolveStale(['stale-generation']);
await flushPromises();
assert.equal(replacements.some((value) => value.includes('stale-generation')), false);
assert.deepEqual(replacements.at(-1), ['new-generation']);

let resolveExternalLate!: (value: readonly string[]) => void;
computations.push(() => new Promise((resolve) => { resolveExternalLate = resolve; }));
lifecycle.requestRefresh(0);
scheduled.at(-1)?.run();
await Promise.resolve();
external = true;
await lifecycle.handleDiagnosticsChanged();
assert.equal(clears, 1, 'external spell diagnostics must remove the internal collection');
assert.equal(publishes, 1, 'the combined VS Code diagnostics must be published');
resolveExternalLate(['must-not-overwrite-external']);
await flushPromises();
assert.equal(replacements.some((value) => value.includes('must-not-overwrite-external')), false);

external = false;
await lifecycle.handleDiagnosticsChanged();
assert.equal(clears, 1, 'unrelated diagnostics must not clear internal spell results');
assert.equal(publishes, 2);

computations.push(async () => { throw new Error('current failure'); });
lifecycle.requestRefresh(0);
scheduled.at(-1)?.run();
await flushPromises();
assert.equal(failures, 1);
assert.equal(clears, 2, 'a current computation failure must degrade by clearing internal diagnostics');

let rejectStale!: (error: Error) => void;
computations.push(() => new Promise((_resolve, reject) => { rejectStale = reject; }));
lifecycle.requestRefresh(0);
scheduled.at(-1)?.run();
await Promise.resolve();
computations.push(async () => ['after-stale-failure']);
lifecycle.requestRefresh(0);
scheduled.at(-1)?.run();
rejectStale(new Error('stale failure'));
await flushPromises();
assert.equal(failures, 1, 'a stale failure must not clear or report over a newer generation');
assert.equal(clears, 2);
assert.deepEqual(replacements.at(-1), ['after-stale-failure']);

let resolveDisposed!: (value: readonly string[]) => void;
computations.push(() => new Promise((resolve) => { resolveDisposed = resolve; }));
lifecycle.requestRefresh(0);
scheduled.at(-1)?.run();
await Promise.resolve();
lifecycle.requestRefresh(350);
const disposeTimer = scheduled.at(-1);
lifecycle.dispose();
assert.equal(disposeTimer?.cancelled, true);
assert.equal(clears, 3, 'dispose must clear the owned diagnostic collection');
resolveDisposed(['after-dispose']);
await flushPromises();
assert.equal(replacements.some((value) => value.includes('after-dispose')), false);

const repoRoot = path.resolve(import.meta.dir, '..');
const panelSession = fs.readFileSync(path.join(repoRoot, 'src/extension/panelSession.ts'), 'utf8');
const hostBootstrap = fs.readFileSync(path.join(repoRoot, 'src/extension.ts'), 'utf8');
for (const legacyIdentifier of [
  'spellCheckGeneration',
  'pendingSpellCheckTimer',
  'runSpellCheck',
  'scheduleSpellCheck'
]) {
  assert.equal(panelSession.includes(legacyIdentifier), false, `Legacy diagnostics state returned: ${legacyIdentifier}`);
}
assert.equal((panelSession.match(/createHostDiagnosticsLifecycle\s*\(/g) ?? []).length, 1);
assert.equal((hostBootstrap.match(/createVscodeSpellDiagnosticsAdapter\s*\(/g) ?? []).length, 1);
assert.equal((hostBootstrap.match(/createHostDiagnosticsTimerAdapter\s*\(/g) ?? []).length, 1);
assert.match(panelSession, /hostDiagnosticsLifecycle\.dispose\(\)/);

console.log('Host diagnostics lifecycle checks passed');
