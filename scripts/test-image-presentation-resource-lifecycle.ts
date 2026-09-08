import assert from 'node:assert/strict';
import {
  createImagePresentationFactory,
  createImagePresentationResourcePool,
  type ImagePresentationResourcePool
} from '../webview/src/editor/imagePresentationAdapter';

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const resolutions: Array<{
  readonly rawSrc: string;
  readonly signal: AbortSignal;
  readonly work: Deferred<string | null>;
}> = [];
const loads: Array<{
  readonly resolvedSrc: string;
  readonly signal: AbortSignal;
  readonly work: Deferred<HTMLImageElement | null>;
}> = [];
let now = 1_000;

const pool = createImagePresentationResourcePool({
  maxConcurrentLoads: 1,
  failureRetryMs: 100,
  now: () => now,
  resolveSource(_contextKey, rawSrc, signal) {
    const work = deferred<string | null>();
    resolutions.push({ rawSrc, signal, work });
    return work.promise;
  },
  loadImage(resolvedSrc, signal) {
    const work = deferred<HTMLImageElement | null>();
    loads.push({ resolvedSrc, signal, work });
    return work.promise;
  }
});

assert.equal(await pool.resolve('document', './source.png'), null, 'zero consumers must not resolve');
assert.equal(await pool.load('document', 'resolved:source'), null, 'zero consumers must not load');
assert.equal(resolutions.length, 0);
assert.equal(loads.length, 0);

const releaseFirst = pool.acquire();
const releaseSecond = pool.acquire();
const sharedResolutionA = pool.resolve('document', './shared.png');
const sharedResolutionB = pool.resolve('document', './shared.png');
assert.equal(resolutions.length, 1, 'two consumers must share one pending resolution');

releaseFirst();
releaseFirst();
assert.equal(resolutions[0].signal.aborted, false, '2→1 release must preserve shared resource work');
resolutions[0].work.resolve('resolved:shared');
assert.equal(await sharedResolutionA, 'resolved:shared');
assert.equal(await sharedResolutionB, 'resolved:shared');

const sharedLoadA = pool.load('document', 'resolved:shared');
const sharedLoadB = pool.load('document', 'resolved:shared');
const queuedLoad = pool.load('document', 'resolved:queued');
assert.equal(loads.length, 1, 'two consumers must share one pending browser load');
releaseSecond();
assert.equal(resolutions[0].signal.aborted, true, 'last release must abort the resource generation');
assert.equal(loads[0].signal.aborted, true, 'last release must abort an active browser load');
assert.equal(await sharedLoadA, null, 'last release must settle active load waiters');
assert.equal(await sharedLoadB, null, 'last release must settle all shared load waiters');
assert.equal(await queuedLoad, null, 'last release must settle queued load waiters');
assert.equal(pool.getResolved('document', './shared.png'), null, 'last release must clear resolution cache');
assert.equal(pool.getLoaded('document', 'resolved:shared'), null, 'last release must clear loaded cache');

loads[0].work.resolve({ src: 'stale' } as HTMLImageElement);
await flushPromises();
assert.equal(pool.getLoaded('document', 'resolved:shared'), null, 'stale completion must not repopulate cache');

const releaseCurrent = pool.acquire();
const staleResolution = pool.resolve('document', './replaced.png');
assert.equal(resolutions.length, 2);
pool.invalidate();
assert.equal(resolutions[1].signal.aborted, true, 'document replacement must abort the old generation');
assert.equal(await staleResolution, null, 'document replacement must settle old resolution waiters');

const currentResolution = pool.resolve('document', './replaced.png');
assert.equal(resolutions.length, 3, 'replacement generation must perform its own resolution');
resolutions[1].work.resolve('resolved:stale');
resolutions[2].work.resolve('resolved:current');
assert.equal(await currentResolution, 'resolved:current');
assert.equal(
  pool.getResolved('document', './replaced.png'),
  'resolved:current',
  'stale resolution must not overwrite the current generation'
);

const currentLoad = pool.load('document', 'resolved:current');
assert.equal(loads.length, 2, 'replacement generation must perform its own browser load');
const currentImage = { src: 'resolved:current' } as HTMLImageElement;
loads[1].work.resolve(currentImage);
assert.equal(await currentLoad, currentImage);
assert.equal(pool.getLoaded('document', 'resolved:current'), currentImage);

const failedLoad = pool.load('document', 'resolved:failed');
assert.equal(loads.length, 3);
loads[2].work.resolve(null);
assert.equal(await failedLoad, null);
assert.equal(await pool.load('document', 'resolved:failed'), null);
assert.equal(loads.length, 3, 'recent error must retain the existing retry throttle');
now += 101;
const retriedLoad = pool.load('document', 'resolved:failed');
assert.equal(loads.length, 4, 'expired error must retry in the current generation');
const retriedImage = { src: 'resolved:failed' } as HTMLImageElement;
loads[3].work.resolve(retriedImage);
assert.equal(await retriedLoad, retriedImage);

const releaseSurvivor = pool.acquire();
releaseCurrent();
assert.equal(pool.getLoaded('document', 'resolved:current'), currentImage, '2→1 must retain ready cache');
releaseSurvivor();
assert.equal(pool.getLoaded('document', 'resolved:current'), null, '1→0 must release ready cache');

const releaseDisposed = pool.acquire();
const pendingAtDispose = pool.resolve('document', './dispose.png');
assert.equal(resolutions.length, 4);
pool.dispose();
assert.equal(resolutions[3].signal.aborted, true, 'dispose must abort the current generation');
assert.equal(await pendingAtDispose, null);
releaseDisposed();
const releaseAfterDispose = pool.acquire();
releaseAfterDispose();
assert.equal(await pool.resolve('document', './after-dispose.png'), null);
assert.equal(await pool.load('document', 'resolved:after-dispose'), null);

let poolAcquireCalls = 0;
let poolDisposeCalls = 0;
const poolLeaseReleases: number[] = [];
const factoryPool: ImagePresentationResourcePool = {
  acquire() {
    const leaseIndex = poolAcquireCalls++;
    poolLeaseReleases[leaseIndex] = 0;
    return () => { poolLeaseReleases[leaseIndex] += 1; };
  },
  invalidate() {},
  invalidateResource() {},
  resolve: async () => null,
  getResolved: () => null,
  load: async () => null,
  getLoaded: () => null,
  dispose() { poolDisposeCalls += 1; }
};
const factory = createImagePresentationFactory({
  resources: factoryPool,
  resourceContextKey: 'factory-matrix'
});
const releaseFactoryFirst = factory.acquire();
const releaseFactorySecond = factory.acquire();
assert.equal(poolAcquireCalls, 2, 'each Factory acquire must own exactly one Pool lease');
releaseFactoryFirst();
releaseFactoryFirst();
assert.deepEqual(poolLeaseReleases, [1, 0], 'Factory release must be one-to-one and idempotent');
factory.dispose();
assert.deepEqual(poolLeaseReleases, [1, 1], 'Factory dispose must reclaim only unreleased Pool leases');
releaseFactorySecond();
assert.deepEqual(poolLeaseReleases, [1, 1], 'released Factory leases must stay idempotent after dispose');
assert.equal(poolDisposeCalls, 0, 'Factory must not take ownership of Pool disposal');
factory.acquire()();
assert.equal(poolAcquireCalls, 2, 'disposed Factory must not acquire a new Pool lease');

console.log('image presentation resource lifecycle matrix passed');
