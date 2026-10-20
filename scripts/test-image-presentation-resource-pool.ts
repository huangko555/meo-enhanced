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
const releasePool = pool.acquire();

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

releasePool();
pool.dispose();
assert.equal(await pool.resolve('document-a', './after-dispose.png'), null);
assert.equal(await pool.load('document-a', 'resolved:after-dispose'), null);

let releasePendingResolution!: (value: string) => void;
let releasePendingLoad!: (value: HTMLImageElement | null) => void;
const disposablePool = createImagePresentationResourcePool({
  maxConcurrentLoads: 1,
  resolveSource: () => new Promise<string>((resolve) => {
    releasePendingResolution = resolve;
  }),
  loadImage: () => new Promise<HTMLImageElement | null>((resolve) => {
    releasePendingLoad = resolve;
  })
});
disposablePool.acquire();
const pendingResolution = disposablePool.resolve('document', 'pending-resolution');
const pendingLoad = disposablePool.load('document', 'pending-load');
const queuedLoad = disposablePool.load('document', 'queued-load');
disposablePool.dispose();
assert.equal(await pendingResolution, null, 'dispose must settle active resolution waiters');
assert.equal(await pendingLoad, null, 'dispose must settle active load waiters');
assert.equal(await queuedLoad, null, 'dispose must settle queued load waiters');
releasePendingResolution('late-resolution');
releasePendingLoad(null);
await flushPromises();

let releaseBoundedResolution!: (value: string) => void;
const boundedLoadReleases: Array<() => void> = [];
const boundedPool = createImagePresentationResourcePool({
  maxPendingResolutions: 1,
  maxConcurrentLoads: 1,
  maxQueuedLoads: 1,
  resolveSource: () => new Promise<string>((resolve) => {
    releaseBoundedResolution = resolve;
  }),
  loadImage: async (resolvedSrc) => {
    await new Promise<void>((resolve) => boundedLoadReleases.push(resolve));
    return { src: resolvedSrc } as HTMLImageElement;
  }
});
boundedPool.acquire();
const boundedResolution = boundedPool.resolve('document', 'first');
assert.equal(
  await boundedPool.resolve('document', 'overflow'),
  null,
  'resolution in-flight capacity must reject unique overflow deterministically'
);
releaseBoundedResolution('resolved:first');
await boundedResolution;
const boundedLoadA = boundedPool.load('document', 'a');
const boundedLoadB = boundedPool.load('document', 'b');
assert.equal(
  await boundedPool.load('document', 'overflow'),
  null,
  'load queue capacity must reject unique overflow deterministically'
);
boundedLoadReleases.shift()?.();
await flushPromises();
boundedLoadReleases.shift()?.();
await Promise.all([boundedLoadA, boundedLoadB]);
boundedPool.dispose();

let refreshResolveCalls = 0;
const refreshLoadFlags: boolean[] = [];
const refreshPool = createImagePresentationResourcePool({
  async resolveSource(_contextKey, rawSrc) {
    refreshResolveCalls += 1;
    return `resolved:${rawSrc}`;
  },
  async loadImage(resolvedSrc, _signal, forceReload) {
    refreshLoadFlags.push(forceReload);
    return { src: resolvedSrc } as HTMLImageElement;
  }
});
const releaseRefreshPool = refreshPool.acquire();
const refreshedRawSrc = './refresh.png';
const refreshedResolvedSrc = await refreshPool.resolve('document', refreshedRawSrc);
assert.ok(refreshedResolvedSrc);
await refreshPool.load('document', refreshedResolvedSrc);
refreshPool.invalidateResource('document', refreshedRawSrc, refreshedResolvedSrc);
assert.equal(await refreshPool.resolve('document', refreshedRawSrc), refreshedResolvedSrc);
await refreshPool.load('document', refreshedResolvedSrc);
assert.equal(refreshResolveCalls, 2, 'single-image refresh must resolve the selected resource again');
assert.deepEqual(
  refreshLoadFlags,
  [false, true],
  'single-image refresh must request one browser cache-bypassing load'
);
releaseRefreshPool();
refreshPool.dispose();

// Resource changes must discard earlier work even within the same document generation.
const sourceCompletions: Array<(value: string) => void> = [];
const imageCompletions: Array<(value: HTMLImageElement) => void> = [];
const changedPool = createImagePresentationResourcePool({
  resolveSource: () => new Promise(resolve => sourceCompletions.push(resolve)),
  loadImage: () => new Promise(resolve => imageCompletions.push(resolve))
});
const releaseChanged = changedPool.acquire();
const oldSource = changedPool.resolve('document', 'short.png');
changedPool.invalidateResource('document', 'short.png', null);
const newSource = changedPool.resolve('document', 'short.png');
sourceCompletions[1]('new.png');
assert.equal(await newSource, 'new.png');
sourceCompletions[0]('old.png');
assert.equal(await oldSource, null);
assert.equal(changedPool.getResolved('document', 'short.png'), 'new.png', 'a late old lookup cannot overwrite the new target');
const oldImage = changedPool.load('document', 'new.png');
changedPool.invalidateResource('document', 'short.png', 'new.png');
const newImage = changedPool.load('document', 'new.png');
imageCompletions[1]({ src: 'new bytes' } as HTMLImageElement);
assert.equal((await newImage)?.src, 'new bytes');
imageCompletions[0]({ src: 'old bytes' } as HTMLImageElement);
assert.equal(await oldImage, null);
assert.equal(changedPool.getLoaded('document', 'new.png')?.src, 'new bytes');
releaseChanged();
changedPool.dispose();

const hinted = createImagePresentationResourcePool({
  resolveSource: async () => 'resolved:picture',
  loadImage: async () => ({ naturalWidth: 800, naturalHeight: 400 } as HTMLImageElement)
});
hinted.seedIntrinsicSizes('document', [{ src: './a b.png', width: 640, height: 360 }]);
assert.deepEqual(hinted.getIntrinsicSize('document', './a%20b.png'), { width: 640, height: 360 }, 'headers must work before URL resolution');
assert.equal(hinted.getIntrinsicSize('other-document', './a b.png'), null, 'header hints must be document-scoped');
const releaseHinted = hinted.acquire();
await hinted.resolve('document', './a%20b.png');
await hinted.load('document', 'resolved:picture');
assert.deepEqual(hinted.getIntrinsicSize('document', './a%20b.png'), { width: 800, height: 400 }, 'decoded dimensions override header hints');
releaseHinted();
const releaseAgain = hinted.acquire();
assert.deepEqual(hinted.getIntrinsicSize('document', './a b.png'), { width: 640, height: 360 }, 'mode round-trips retain bounded header hints');
hinted.invalidateResource('document', './a b.png', null);
assert.equal(hinted.getIntrinsicSize('document', './a b.png'), null, 'resource changes must retire old header hints');
releaseAgain();
hinted.dispose();

console.log('image presentation resource pool contracts passed');
