import assert from 'node:assert/strict';
import { createImagePresentationResourcePool } from '../webview/src/editor/imagePresentationAdapter';

let now = 1_000;
let resolveCalls = 0;
let loadCalls = 0;
let activeLoads = 0;
let maxActiveLoads = 0;
const failing = new Set<string>();
const loadReleases: Array<() => void> = [];
const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const pool = createImagePresentationResourcePool({
  maxConcurrentLoads: 2,
  failureRetryMs: 30_000,
  now: () => now,
  async resolveSource(contextKey, rawSrc) {
    resolveCalls += 1;
    return `${contextKey}:${rawSrc}`;
  },
  async loadImage(resolvedSrc) {
    loadCalls += 1;
    activeLoads += 1;
    maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
    await new Promise<void>((resolve) => loadReleases.push(resolve));
    activeLoads -= 1;
    return failing.has(resolvedSrc) ? null : ({ src: resolvedSrc, cloneNode: () => ({ src: resolvedSrc }) } as never);
  }
});

const sameA = pool.resolve('document-a', './same.png');
const sameB = pool.resolve('document-a', './same.png');
assert.equal(await sameA, 'document-a:./same.png');
assert.equal(await sameB, 'document-a:./same.png');
assert.equal(resolveCalls, 1, 'same context/source should share one resolution');
assert.equal(await pool.resolve('document-b', './same.png'), 'document-b:./same.png');
assert.equal(resolveCalls, 2, 'different document contexts must not share resolution cache');

const loadA = pool.load('document-a', 'resolved:a');
const loadAShared = pool.load('document-a', 'resolved:a');
const loadB = pool.load('document-a', 'resolved:b');
const loadC = pool.load('document-a', 'resolved:c');
await Promise.resolve();
assert.equal(loadCalls, 2, 'load queue exceeded its configured concurrency before release');
assert.equal(maxActiveLoads, 2);
loadReleases.splice(0, 2).forEach((release) => release());
await flushPromises();
assert.equal(loadCalls, 3, 'queued load did not start after a slot became available');
loadReleases.splice(0).forEach((release) => release());
const [loadedA, loadedAShared, loadedB, loadedC] = await Promise.all([loadA, loadAShared, loadB, loadC]);
assert.ok(loadedA && loadedB && loadedC);
assert.equal(loadedA, loadedAShared, 'same resource should share one loaded result');
assert.equal(loadCalls, 3, 'same resource should share one browser load');

failing.add('resolved:missing');
const failed = pool.load('document-a', 'resolved:missing');
await Promise.resolve();
loadReleases.shift()?.();
assert.equal(await failed, null);
const failedCached = await pool.load('document-a', 'resolved:missing');
assert.equal(failedCached, null);
assert.equal(loadCalls, 4, 'recent failure should suppress immediate retry');
now += 30_001;
const retried = pool.load('document-a', 'resolved:missing');
await Promise.resolve();
loadReleases.shift()?.();
await retried;
assert.equal(loadCalls, 5, 'expired failure should retry');

pool.dispose();
assert.equal(await pool.resolve('document-a', './after-dispose.png'), null);
assert.equal(await pool.load('document-a', 'resolved:after-dispose'), null);

console.log('image presentation resource pool contracts passed');
