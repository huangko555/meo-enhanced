import assert from 'node:assert/strict';
import { createMermaidDiagramPresentationApplication } from '../webview/src/application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from '../webview/src/adapters/mermaidDiagramPresentationRuntime';
import { createMermaidDiagramPresentationEffectAdapter } from '../webview/src/editor/mermaidDiagramPresentationAdapter';
import { createMermaidDiagramPresentationFactory } from '../webview/src/editor/mermaidDiagramPresentation';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';

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

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let index = 0; index < 100 && !condition(); index += 1) await Promise.resolve();
  assert.equal(condition(), true, 'deterministic Mermaid renderer did not reach the expected state');
};

const request = (
  rawSource: string,
  themeKey = 'light',
  configKey = 'default'
) => ({ rawSource, normalizedSource: rawSource.trim(), themeKey, configKey } as const);

const renderGates: Array<{ readonly source: string; readonly gate: Deferred<string> }> = [];
const initializeCalls: Array<[string, string]> = [];
const pool = createMermaidDiagramRenderPool({
  initialize(themeKey, configKey) {
    initializeCalls.push([themeKey, configKey]);
  },
  render(_renderId, source) {
    const gate = deferred<string>();
    renderGates.push({ source, gate });
    return gate.promise;
  }
});

const sharedRequest = request('graph TD\nA-->B');
assert.equal(pool.getCached(sharedRequest), null);
assert.equal(renderGates.length, 0, 'zero consumers must not initialize, queue, or render');

const first = pool.acquire();
const second = pool.acquire();
const firstPending = first.render(sharedRequest);
const secondPending = second.render(sharedRequest);
await waitFor(() => renderGates.length === 1);
assert.deepEqual(initializeCalls, [['light', 'default']]);

first.release();
first.release();
assert.match((await firstPending).error, /released/);
let secondSettled = false;
void secondPending.then(() => { secondSettled = true; });
await Promise.resolve();
assert.equal(secondSettled, false, '2→1 release must not settle the surviving consumer');
renderGates[0]!.gate.resolve('<svg data-generation="shared"></svg>');
assert.deepEqual(await secondPending, { ok: true, svg: '<svg data-generation="shared"></svg>' });

const cachedConsumer = pool.acquire();
assert.deepEqual(await cachedConsumer.render(sharedRequest), {
  ok: true,
  svg: '<svg data-generation="shared"></svg>'
});
assert.equal(renderGates.length, 1, 'same-key consumers must reuse the shared cache');
second.release();
assert.notEqual(pool.getCached(sharedRequest), null, 'one surviving consumer must retain shared results');
cachedConsumer.release();
cachedConsumer.release();
assert.notEqual(
  pool.getCached(sharedRequest),
  null,
  'last release keeps bounded completed results reusable across viewport-driven Widget recreation'
);

const replacement = pool.acquire();
const oldRequest = request('graph TD\nOLD-->STALE');
const latestRequest = request('graph TD\nLATEST-->READY', 'dark', 'strict');
const oldPending = replacement.render(oldRequest);
await waitFor(() => renderGates.length === 2);
replacement.invalidate();
assert.match((await oldPending).error, /replaced/);
const latestPending = replacement.render(latestRequest);
renderGates[1]!.gate.resolve('<svg data-generation="old"></svg>');
await waitFor(() => renderGates.length === 3);
renderGates[2]!.gate.resolve('<svg data-generation="latest"></svg>');
assert.deepEqual(await latestPending, { ok: true, svg: '<svg data-generation="latest"></svg>' });
assert.equal(pool.getCached(oldRequest), null, 'stale replacement completion must not enter cache');
assert.deepEqual(pool.getCached(latestRequest), {
  ok: true,
  svg: '<svg data-generation="latest"></svg>'
});

const errorRequest = request('INVALID');
replacement.invalidate();
const failed = replacement.render(errorRequest);
await waitFor(() => renderGates.length === 4);
renderGates[3]!.gate.reject(new Error('parse error'));
assert.deepEqual(await failed, { ok: false, error: 'parse error' });
assert.deepEqual(await replacement.render(errorRequest), { ok: false, error: 'parse error' });
assert.equal(renderGates.length, 4, 'error result remains cached within the active generation');
replacement.invalidate();
const retried = replacement.render(errorRequest);
await waitFor(() => renderGates.length === 5);
renderGates[4]!.gate.resolve('<svg data-generation="retry"></svg>');
assert.deepEqual(await retried, { ok: true, svg: '<svg data-generation="retry"></svg>' });

let themeRefreshCount = 0;
const unsubscribe = pool.subscribeThemeRefresh(() => { themeRefreshCount += 1; });
replacement.invalidate();
const oldThemePending = replacement.render(request('THEME_RACE'));
await waitFor(() => renderGates.length === 6);
pool.refreshTheme();
assert.match((await oldThemePending).error, /theme generation/);
const newThemePending = replacement.render(request('THEME_RACE'));
renderGates[5]!.gate.resolve('<svg data-generation="old-theme"></svg>');
await waitFor(() => renderGates.length === 7);
renderGates[6]!.gate.resolve('<svg data-generation="new-theme"></svg>');
assert.deepEqual(await newThemePending, { ok: true, svg: '<svg data-generation="new-theme"></svg>' });
assert.equal(themeRefreshCount, 1);
unsubscribe();
pool.refreshTheme();
assert.equal(themeRefreshCount, 1, 'unsubscribed theme listener must not be retained');
replacement.release();

const offscreenGate = deferred<string>();
const offscreenPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => offscreenGate.promise
});
const liveEditorLease = offscreenPool.acquire();
const offscreenWidget = liveEditorLease.fork();
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
liveEditorLease.release();
offscreenPool.dispose();

const externalGate = deferred<string>();
const externalPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => externalGate.promise
});
const externalEditor = externalPool.acquire();
const externalWidget = externalEditor.fork();
const externalRequest = request('OFFSCREEN_BEFORE_EXTERNAL');
const externalPending = externalWidget.render(externalRequest);
await Promise.resolve();
externalWidget.release();
assert.match((await externalPending).error, /released/);
externalEditor.invalidate();
externalGate.resolve('<svg data-generation="stale-external"></svg>');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  externalPool.getCached(externalRequest),
  null,
  'external replacement must invalidate offscreen work retained by the same Live Editor group'
);
externalEditor.release();
externalPool.dispose();

const priorityOrder: string[] = [];
const priorityPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() { return '<svg></svg>'; }
});
const priorityConsumer = priorityPool.acquire();
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
priorityConsumer.release();
priorityPool.dispose();

let capacityRenderCount = 0;
const capacityPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() {
    capacityRenderCount += 1;
    return '<svg></svg>';
  },
  maxQueuedOperations: 1
});
const capacityConsumer = capacityPool.acquire();
const capacityGate = deferred<void>();
const capacityActive = capacityConsumer.runExclusive(() => capacityGate.promise);
const capacityQueued = capacityConsumer.runExclusive(async () => undefined);
await assert.rejects(
  capacityConsumer.runExclusive(async () => undefined),
  /queue capacity exceeded/
);
const capacityRequest = request('retry-after-capacity');
assert.deepEqual(await capacityConsumer.render(capacityRequest), {
  ok: false,
  error: 'Mermaid render queue capacity exceeded'
});
capacityGate.resolve();
await Promise.all([capacityActive, capacityQueued]);
assert.deepEqual(await capacityConsumer.render(capacityRequest), { ok: true, svg: '<svg></svg>' });
assert.equal(capacityRenderCount, 1);
capacityConsumer.release();
capacityPool.dispose();

const abandonedGate = deferred<string>();
let abandonedRenderStarted = false;
const abandonedPool = createMermaidDiagramRenderPool({
  initialize() {},
  render() {
    abandonedRenderStarted = true;
    return abandonedGate.promise;
  }
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
firstHandle.present(sharedRequest.rawSource, sharedRequest.themeKey, sharedRequest.configKey);
secondHandle.present(sharedRequest.rawSource, sharedRequest.themeKey, sharedRequest.configKey);
await waitFor(() => abandonedRenderStarted);
firstEditor.externalDocumentPresented();
firstHandle.dispose();
abandonedGate.resolve('<svg data-generation="survivor"></svg>');
await secondHandle.whenIdle();
assert.equal(viewEvents.first.some((event) => event.includes('survivor')), false);
assert.equal(viewEvents.second.some((event) => event.includes('survivor')), true);
assert.notEqual(abandonedPool.getCached(sharedRequest), null, 'other Editor consumer keeps shared work alive');
secondHandle.dispose();
secondEditor.dispose();
firstEditor.dispose();
assert.notEqual(abandonedPool.getCached(sharedRequest), null, 'completed shared result remains reusable');
abandonedFactory.dispose();
abandonedFactory.dispose();
abandonedPool.dispose();

const orphanGate = deferred<string>();
let orphanStarted = false;
const orphanPool = createMermaidDiagramRenderPool({
  initialize() {},
  render() {
    orphanStarted = true;
    return orphanGate.promise;
  }
});
const orphanConsumer = orphanPool.acquire();
const unrelatedPreviewConsumer = orphanPool.acquire();
const orphanRequest = request('ORPHAN_AFTER_SOURCE_EXIT');
const orphanPending = orphanConsumer.render(orphanRequest);
await waitFor(() => orphanStarted);
orphanConsumer.release();
assert.match((await orphanPending).error, /released/);
orphanGate.resolve('<svg data-generation="orphan"></svg>');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(orphanPool.getCached(orphanRequest), null, 'last release must reject orphan completion cache writes');
unrelatedPreviewConsumer.release();
orphanPool.dispose();

const never = new Promise<string>(() => undefined);
const disposalPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => never
});
const disposalConsumer = disposalPool.acquire();
const activeRender = disposalConsumer.render(request('never'));
const queuedExclusive = disposalConsumer.runExclusive(async () => undefined);
disposalPool.dispose();
disposalPool.dispose();
assert.deepEqual(await activeRender, { ok: false, error: 'Mermaid render Pool is disposed' });
await assert.rejects(queuedExclusive, /disposed/);
disposalConsumer.release();

pool.dispose();
pool.dispose();
assert.deepEqual(await pool.acquire().render(sharedRequest), {
  ok: false,
  error: 'Mermaid render Pool is disposed'
});

console.log('Mermaid diagram Render Pool consumer lifecycle contracts passed');
