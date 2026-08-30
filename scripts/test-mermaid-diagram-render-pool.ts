import assert from 'node:assert/strict';
import { createMermaidDiagramPresentationApplication } from '../webview/src/application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from '../webview/src/adapters/mermaidDiagramPresentationRuntime';
import {
  createMermaidDiagramPresentationEffectAdapter,
  type MermaidDiagramPresentationAdapterOptions
} from '../webview/src/editor/mermaidDiagramPresentationAdapter';
import { createMermaidDiagramPresentationFactory } from '../webview/src/editor/mermaidDiagramPresentation';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import type {
  MermaidDiagramLeafRenderConsumer,
  MermaidDiagramRenderGroupLease
} from '../webview/src/application/mermaidDiagramRenderResources';

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type _LeafHasNoGroupOwnerCapability = Assert<IsNever<Extract<
  keyof MermaidDiagramLeafRenderConsumer,
  'createLeaf' | 'runExclusive' | 'replaceForExternalDocument' | 'end'
>>>;
type _GroupHasNoLeafCapability = Assert<IsNever<Extract<
  keyof MermaidDiagramRenderGroupLease,
  'render' | 'getCached' | 'replacePending' | 'release'
>>>;
type _AdapterReceivesOnlyLeaf = Assert<
  MermaidDiagramPresentationAdapterOptions['resources'] extends MermaidDiagramLeafRenderConsumer
    ? true
    : false
>;

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((settle, fail) => {
      resolve = settle;
      reject = fail;
    }),
    resolve,
    reject
  };
};

type ControlledRender = {
  readonly source: string;
  readonly gate: Deferred<string>;
};

const createControlledRenderer = () => {
  let started = deferred<ControlledRender>();
  return {
    nextStarted: () => started.promise,
    render(_renderId: string, source: string): Promise<string> {
      const currentStarted = started;
      started = deferred<ControlledRender>();
      const gate = deferred<string>();
      currentStarted.resolve({ source, gate });
      return gate.promise;
    }
  };
};

const request = (
  rawSource: string,
  themeKey = 'light',
  configKey = 'default'
) => ({ rawSource, normalizedSource: rawSource.trim(), themeKey, configKey } as const);

const controlledRenderer = createControlledRenderer();
const initializeCalls: Array<[string, string]> = [];
const pool = createMermaidDiagramRenderPool({
  initialize(themeKey, configKey) {
    initializeCalls.push([themeKey, configKey]);
  },
  render: controlledRenderer.render
});

const sharedRequest = request('graph TD\nA-->B');
assert.equal(pool.getCached(sharedRequest), null);
assert.deepEqual(initializeCalls, [], 'zero consumers must not initialize, queue, or render');

const firstGroup = pool.acquireGroup();
const secondGroup = pool.acquireGroup();
const first = firstGroup.createLeaf();
const second = secondGroup.createLeaf();
const sharedRenderStarted = controlledRenderer.nextStarted();
const firstPending = first.render(sharedRequest);
const secondPending = second.render(sharedRequest);
const sharedRender = await sharedRenderStarted;
assert.deepEqual(initializeCalls, [['light', 'default']]);

first.release();
first.release();
firstGroup.end();
assert.match((await firstPending).error, /released/);
let secondSettled = false;
void secondPending.then(() => { secondSettled = true; });
await Promise.resolve();
assert.equal(secondSettled, false, '2→1 release must not settle the surviving consumer');
sharedRender.gate.resolve('<svg data-generation="shared"></svg>');
assert.deepEqual(await secondPending, { ok: true, svg: '<svg data-generation="shared"></svg>' });

const cachedGroup = pool.acquireGroup();
const cachedConsumer = cachedGroup.createLeaf();
assert.deepEqual(await cachedConsumer.render(sharedRequest), {
  ok: true,
  svg: '<svg data-generation="shared"></svg>'
});
second.release();
secondGroup.end();
assert.notEqual(pool.getCached(sharedRequest), null, 'one surviving consumer must retain shared results');
cachedConsumer.release();
cachedConsumer.release();
cachedGroup.end();
assert.notEqual(
  pool.getCached(sharedRequest),
  null,
  'last release keeps bounded completed results reusable across viewport-driven Widget recreation'
);

const replacementGroup = pool.acquireGroup();
const replacement = replacementGroup.createLeaf();
const oldRequest = request('graph TD\nOLD-->STALE');
const latestRequest = request('graph TD\nLATEST-->READY', 'dark', 'strict');
const oldRenderStarted = controlledRenderer.nextStarted();
const oldPending = replacement.render(oldRequest);
const oldRender = await oldRenderStarted;
replacement.replacePending();
assert.match((await oldPending).error, /replaced/);
const latestPending = replacement.render(latestRequest);
const latestRenderStarted = controlledRenderer.nextStarted();
oldRender.gate.resolve('<svg data-generation="old"></svg>');
const latestRender = await latestRenderStarted;
latestRender.gate.resolve('<svg data-generation="latest"></svg>');
assert.deepEqual(await latestPending, { ok: true, svg: '<svg data-generation="latest"></svg>' });
assert.deepEqual(
  pool.getCached(oldRequest),
  { ok: true, svg: '<svg data-generation="old"></svg>' },
  'leaf replacement detaches stale DOM correlation but keeps Pool-owned reusable content'
);
assert.deepEqual(pool.getCached(latestRequest), {
  ok: true,
  svg: '<svg data-generation="latest"></svg>'
});

const errorRequest = request('INVALID');
replacement.replacePending();
const failedRenderStarted = controlledRenderer.nextStarted();
const failed = replacement.render(errorRequest);
const failedRender = await failedRenderStarted;
failedRender.gate.reject(new Error('parse error'));
assert.deepEqual(await failed, { ok: false, error: 'parse error' });
const retriedRenderStarted = controlledRenderer.nextStarted();
const retried = replacement.render(errorRequest);
const retriedRender = await retriedRenderStarted;
retriedRender.gate.resolve('<svg data-generation="retry"></svg>');
assert.deepEqual(await retried, { ok: true, svg: '<svg data-generation="retry"></svg>' });

let themeRefreshCount = 0;
const unsubscribe = pool.subscribeThemeRefresh(() => { themeRefreshCount += 1; });
replacement.replacePending();
const oldThemeRenderStarted = controlledRenderer.nextStarted();
const oldThemePending = replacement.render(request('THEME_RACE'));
const oldThemeRender = await oldThemeRenderStarted;
pool.refreshTheme();
assert.match((await oldThemePending).error, /theme generation/);
const newThemePending = replacement.render(request('THEME_RACE'));
const newThemeRenderStarted = controlledRenderer.nextStarted();
oldThemeRender.gate.resolve('<svg data-generation="old-theme"></svg>');
const newThemeRender = await newThemeRenderStarted;
newThemeRender.gate.resolve('<svg data-generation="new-theme"></svg>');
assert.deepEqual(await newThemePending, { ok: true, svg: '<svg data-generation="new-theme"></svg>' });
assert.equal(themeRefreshCount, 1);
unsubscribe();
pool.refreshTheme();
assert.equal(themeRefreshCount, 1, 'unsubscribed theme listener must not be retained');
replacement.release();
replacementGroup.end();

const offscreenGate = deferred<string>();
const offscreenPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => offscreenGate.promise
});
const liveEditorLease = offscreenPool.acquireGroup();
const offscreenWidget = liveEditorLease.createLeaf();
const offscreenRequest = request('LIVE_WIDGET_OFFSCREEN');
const offscreenPending = offscreenWidget.render(offscreenRequest);
await Promise.resolve();
offscreenWidget.release();
assert.match((await offscreenPending).error, /released/);
offscreenGate.resolve('<svg data-generation="offscreen-reuse"></svg>');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(offscreenPool.getCached(offscreenRequest), {
  ok: true,
  svg: '<svg data-generation="offscreen-reuse"></svg>'
});
liveEditorLease.end();
offscreenPool.dispose();

const completedCachePool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() { return '<svg data-generation="completed"></svg>'; }
});
const completedCacheRoot = completedCachePool.acquireGroup();
const completedCacheLeaf = completedCacheRoot.createLeaf();
const completedCacheRequest = request('COMPLETED_CACHE_SURVIVES_CHILD_REPLACEMENT');
assert.deepEqual(await completedCacheLeaf.render(completedCacheRequest), {
  ok: true,
  svg: '<svg data-generation="completed"></svg>'
});
completedCacheLeaf.replacePending();
assert.deepEqual(
  completedCachePool.getCached(completedCacheRequest),
  { ok: true, svg: '<svg data-generation="completed"></svg>' },
  'child replacement must not delete the Pool-owned successful cache'
);
completedCacheLeaf.release();
completedCacheRoot.end();
completedCacheRoot.end();
assert.throws(() => completedCacheRoot.createLeaf(), /ended/);
await assert.rejects(completedCacheRoot.runExclusive(async () => undefined), /ended/);
assert.throws(() => completedCacheRoot.replaceForExternalDocument(), /ended/);
assert.deepEqual(await completedCacheLeaf.render(completedCacheRequest), {
  ok: false,
  error: 'Mermaid render leaf consumer is released',
  unavailable: true
});
completedCachePool.dispose();

let lruRenderCount = 0;
const lruPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render(_renderId, source) {
    lruRenderCount += 1;
    return `<svg data-source="${source}"></svg>`;
  },
  cacheLimit: 2
});
const lruGroup = lruPool.acquireGroup();
const lruLeaf = lruGroup.createLeaf();
const lruA = request('LRU_A');
const lruB = request('LRU_B');
const lruC = request('LRU_C');
await lruLeaf.render(lruA);
await lruLeaf.render(lruB);
assert.notEqual(lruPool.getCached(lruA), null, 'cache lookup must refresh Pool LRU recency');
await lruLeaf.render(lruC);
assert.notEqual(lruPool.getCached(lruA), null);
assert.equal(lruPool.getCached(lruB), null, 'capacity eviction removes the least-recent Pool entry');
assert.notEqual(lruPool.getCached(lruC), null);
assert.equal(lruRenderCount, 3);
lruLeaf.release();
lruGroup.end();
lruPool.dispose();

const siblingGate = deferred<string>();
const siblingPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => siblingGate.promise
});
const siblingRoot = siblingPool.acquireGroup();
const siblingA = siblingRoot.createLeaf();
const siblingB = siblingRoot.createLeaf();
const siblingRequest = request('LIVE_SIBLING_REPLACEMENT');
const siblingPendingA = siblingA.render(siblingRequest);
const siblingPendingB = siblingB.render(siblingRequest);
await Promise.resolve();
siblingA.release();
siblingB.replacePending();
assert.match((await siblingPendingA).error, /released/);
assert.match((await siblingPendingB).error, /replaced/);
siblingGate.resolve('<svg data-generation="sibling-reuse"></svg>');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(
  siblingPool.getCached(siblingRequest),
  { ok: true, svg: '<svg data-generation="sibling-reuse"></svg>' },
  'an active Live group must retain offscreen work after sibling release and replacement'
);
siblingRoot.end();
siblingPool.dispose();

const externalGate = deferred<string>();
const externalPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => externalGate.promise
});
const externalEditor = externalPool.acquireGroup();
const externalWidget = externalEditor.createLeaf();
const externalRequest = request('OFFSCREEN_BEFORE_EXTERNAL');
const externalPending = externalWidget.render(externalRequest);
await Promise.resolve();
externalWidget.release();
assert.match((await externalPending).error, /released/);
externalEditor.replaceForExternalDocument();
externalGate.resolve('<svg data-generation="stale-external"></svg>');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  externalPool.getCached(externalRequest),
  null,
  'external replacement must invalidate offscreen work retained by the same Live Editor group'
);
externalEditor.end();
externalPool.dispose();

const priorityOrder: string[] = [];
const priorityPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() { return '<svg></svg>'; }
});
const priorityConsumer = priorityPool.acquireGroup();
const activeGate = deferred<void>();
const activeOperation = priorityConsumer.runExclusive(async () => {
  priorityOrder.push('active');
  await activeGate.promise;
});
const normalOne = priorityConsumer.runExclusive(async () => { priorityOrder.push('normal-1'); });
const highOne = priorityConsumer.runExclusive(async () => { priorityOrder.push('high-1'); }, 'high');
const normalTwo = priorityConsumer.runExclusive(async () => { priorityOrder.push('normal-2'); });
const highTwo = priorityConsumer.runExclusive(async () => { priorityOrder.push('high-2'); }, 'high');
activeGate.resolve();
await Promise.all([activeOperation, normalOne, highOne, normalTwo, highTwo]);
assert.deepEqual(priorityOrder, ['active', 'high-1', 'high-2', 'normal-1', 'normal-2']);
priorityConsumer.end();
priorityPool.dispose();

let queuedRenderCount = 0;
const queuedPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() {
    queuedRenderCount += 1;
    return '<svg data-generation="queued"></svg>';
  }
});
const queueBlocker = queuedPool.acquireGroup();
const queueBlockerGate = deferred<void>();
const blockingOperation = queueBlocker.runExclusive(() => queueBlockerGate.promise);
const queuedGroup = queuedPool.acquireGroup();
const queuedLeaf = queuedGroup.createLeaf();
const queuedRequest = request('QUEUED_GROUP_END');
const abandonedQueued = queuedLeaf.render(queuedRequest);
queuedLeaf.release();
queuedGroup.end();
assert.match((await abandonedQueued).error, /released/);
queueBlockerGate.resolve();
await blockingOperation;
await Promise.resolve();
assert.equal(queuedRenderCount, 0, 'an orphaned queued render must never start');
assert.equal(queuedPool.getCached(queuedRequest), null);
queueBlocker.end();
queuedPool.dispose();

let capacityRenderCount = 0;
const capacityPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() {
    capacityRenderCount += 1;
    return '<svg></svg>';
  },
  maxQueuedOperations: 1
});
const capacityConsumer = capacityPool.acquireGroup();
const capacityLeaf = capacityConsumer.createLeaf();
const capacityGate = deferred<void>();
const capacityActive = capacityConsumer.runExclusive(() => capacityGate.promise);
const capacityQueued = capacityConsumer.runExclusive(async () => undefined);
await assert.rejects(
  capacityConsumer.runExclusive(async () => undefined),
  /queue capacity exceeded/
);
const capacityRequest = request('retry-after-capacity');
assert.deepEqual(await capacityLeaf.render(capacityRequest), {
  ok: false,
  error: 'Mermaid render queue capacity exceeded',
  unavailable: true
});
capacityGate.resolve();
await Promise.all([capacityActive, capacityQueued]);
assert.deepEqual(await capacityLeaf.render(capacityRequest), { ok: true, svg: '<svg></svg>' });
assert.equal(capacityRenderCount, 1);
capacityLeaf.release();
capacityConsumer.end();
capacityPool.dispose();

const abandonedRenderer = createControlledRenderer();
const abandonedPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: abandonedRenderer.render
});
const abandonedFactory = createMermaidDiagramPresentationFactory({
  resources: abandonedPool,
  createHandle(view, resources) {
    const application = createMermaidDiagramPresentationApplication();
    const executor = createMermaidDiagramPresentationEffectAdapter({
      view,
      resources,
      normalizeSource: (source) => source.trim()
    });
    const runtime = createMermaidDiagramPresentationRuntime({ application, executor });
    return {
      present(source, themeKey, configKey) {
        runtime.dispatch({ type: 'present', source, themeKey, configKey });
      },
      externalDocumentPresented() {
        runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenIdle: () => runtime.whenCurrentPresentationSettles(),
      dispose: () => runtime.dispose()
    };
  }
});
const firstEditor = abandonedFactory.createConsumer();
const secondEditor = abandonedFactory.createConsumer();
firstEditor.acquire();
secondEditor.acquire();
const viewEvents = { first: [] as string[], second: [] as string[] };
const createView = (events: string[]) => ({
  showPending() { events.push('pending'); },
  showDiagram(svg: string) { events.push(svg); },
  showError(_source: string, error: string) { events.push(error); },
  clearPresentation() { events.push('clear'); },
  preserveLayoutChange(apply: () => void) { apply(); }
});
const firstHandle = firstEditor.create(createView(viewEvents.first));
const secondHandle = secondEditor.create(createView(viewEvents.second));
const abandonedStarted = abandonedRenderer.nextStarted();
firstHandle.present(sharedRequest.rawSource, sharedRequest.themeKey, sharedRequest.configKey);
secondHandle.present(sharedRequest.rawSource, sharedRequest.themeKey, sharedRequest.configKey);
const abandonedRender = await abandonedStarted;
firstEditor.externalDocumentPresented();
firstHandle.dispose();
abandonedRender.gate.resolve('<svg data-generation="survivor"></svg>');
await secondHandle.whenIdle();
assert.equal(viewEvents.first.some((event) => event.includes('survivor')), false);
assert.equal(viewEvents.second.some((event) => event.includes('survivor')), true);
assert.equal(
  abandonedPool.getCached(sharedRequest),
  null,
  'retired shared work may serve existing siblings but must not become reusable cache content'
);
secondHandle.dispose();
secondEditor.dispose();
firstEditor.dispose();
assert.equal(abandonedPool.getCached(sharedRequest), null);
abandonedFactory.dispose();
abandonedFactory.dispose();
abandonedPool.dispose();

const externalReplacementRenderer = createControlledRenderer();
const externalReplacementPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: externalReplacementRenderer.render
});
const externalReplacementFactory = createMermaidDiagramPresentationFactory({
  resources: externalReplacementPool,
  createHandle(view, resources) {
    const application = createMermaidDiagramPresentationApplication();
    const executor = createMermaidDiagramPresentationEffectAdapter({
      view,
      resources,
      normalizeSource: (source) => source.trim()
    });
    const runtime = createMermaidDiagramPresentationRuntime({ application, executor });
    return {
      present(source, themeKey, configKey) {
        runtime.dispatch({ type: 'present', source, themeKey, configKey });
      },
      externalDocumentPresented() {
        runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenIdle: () => runtime.whenCurrentPresentationSettles(),
      dispose: () => runtime.dispose()
    };
  }
});
const externalReplacementConsumer = externalReplacementFactory.createConsumer();
const releaseExternalReplacementConsumer = externalReplacementConsumer.acquire();
const externalReplacementSibling = externalReplacementFactory.createConsumer();
const releaseExternalReplacementSibling = externalReplacementSibling.acquire();
const externalReplacementEvents: string[] = [];
const externalReplacementSiblingEvents: string[] = [];
const externalReplacementHandle = externalReplacementConsumer.create(
  createView(externalReplacementEvents)
);
const externalReplacementSiblingHandle = externalReplacementSibling.create(
  createView(externalReplacementSiblingEvents)
);
const oldExternalStarted = externalReplacementRenderer.nextStarted();
externalReplacementHandle.present(
  sharedRequest.rawSource,
  sharedRequest.themeKey,
  sharedRequest.configKey
);
externalReplacementSiblingHandle.present(
  sharedRequest.rawSource,
  sharedRequest.themeKey,
  sharedRequest.configKey
);
const oldExternalRender = await oldExternalStarted;
const newExternalStarted = externalReplacementRenderer.nextStarted();
externalReplacementConsumer.externalDocumentPresented();
oldExternalRender.gate.resolve('<svg data-generation="sibling-old"></svg>');
await externalReplacementSiblingHandle.whenIdle();
assert.equal(
  externalReplacementEvents.some((event) => event.includes('sibling-old')),
  false,
  'the old shared completion must have zero effect on the externally replaced Editor'
);
assert.equal(
  externalReplacementSiblingEvents.some((event) => event.includes('sibling-old')),
  true,
  'the old shared completion must still serve its existing sibling Editor'
);
const newExternalRender = await newExternalStarted;
newExternalRender.gate.resolve('<svg data-generation="current-external"></svg>');
await externalReplacementHandle.whenIdle();
assert.equal(
  externalReplacementEvents.filter((event) => event.includes('current-external')).length,
  1,
  'the replacement generation must reach ready exactly once'
);

const sharedErrorRequest = request('graph TD\nSHARED_OLD_ERROR-->CURRENT_ERROR');
const oldErrorStarted = externalReplacementRenderer.nextStarted();
externalReplacementHandle.present(
  sharedErrorRequest.rawSource,
  sharedErrorRequest.themeKey,
  sharedErrorRequest.configKey
);
externalReplacementSiblingHandle.present(
  sharedErrorRequest.rawSource,
  sharedErrorRequest.themeKey,
  sharedErrorRequest.configKey
);
const oldErrorRender = await oldErrorStarted;
const newErrorStarted = externalReplacementRenderer.nextStarted();
externalReplacementConsumer.externalDocumentPresented();
externalReplacementConsumer.externalDocumentPresented();
oldErrorRender.gate.reject(new Error('old sibling parse error'));
await externalReplacementSiblingHandle.whenIdle();
assert.equal(
  externalReplacementEvents.includes('old sibling parse error'),
  false,
  'the old shared error must have zero effect on the repeatedly replaced Editor'
);
assert.equal(
  externalReplacementSiblingEvents.includes('old sibling parse error'),
  true,
  'the old shared error must still serve its existing sibling Editor'
);
const newErrorRender = await newErrorStarted;
newErrorRender.gate.reject(new Error('current external parse error'));
await externalReplacementHandle.whenIdle();
assert.equal(
  externalReplacementEvents.filter((event) => event === 'current external parse error').length,
  1,
  'only the latest replacement error may reach the replaced Editor'
);
assert.equal(externalReplacementPool.getCached(sharedErrorRequest), null);
externalReplacementHandle.dispose();
externalReplacementSiblingHandle.dispose();
releaseExternalReplacementConsumer();
releaseExternalReplacementSibling();
externalReplacementConsumer.dispose();
externalReplacementSibling.dispose();
externalReplacementFactory.dispose();
externalReplacementPool.dispose();

const orphanRenderer = createControlledRenderer();
const orphanPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: orphanRenderer.render
});
const orphanGroup = orphanPool.acquireGroup();
const orphanConsumer = orphanGroup.createLeaf();
const unrelatedPreviewConsumer = orphanPool.acquireGroup();
const orphanRequest = request('ORPHAN_AFTER_SOURCE_EXIT');
const orphanStarted = orphanRenderer.nextStarted();
const orphanPending = orphanConsumer.render(orphanRequest);
const orphanRender = await orphanStarted;
orphanConsumer.release();
orphanGroup.end();
assert.match((await orphanPending).error, /released/);
orphanRender.gate.resolve('<svg data-generation="orphan"></svg>');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(orphanPool.getCached(orphanRequest), null, 'last release must reject orphan completion cache writes');
unrelatedPreviewConsumer.end();
orphanPool.dispose();

const never = new Promise<string>(() => undefined);
const disposalPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => never
});
const disposalConsumer = disposalPool.acquireGroup();
const disposalLeaf = disposalConsumer.createLeaf();
const activeRender = disposalLeaf.render(request('never'));
const queuedExclusive = disposalConsumer.runExclusive(async () => undefined);
disposalPool.dispose();
disposalPool.dispose();
assert.deepEqual(await activeRender, {
  ok: false,
  error: 'Mermaid render Pool is disposed',
  unavailable: true
});
await assert.rejects(queuedExclusive, /disposed/);
disposalLeaf.release();
disposalConsumer.end();

pool.dispose();
pool.dispose();
assert.throws(() => pool.acquireGroup(), /disposed/);

console.log('Mermaid diagram Render Pool consumer lifecycle contracts passed');
