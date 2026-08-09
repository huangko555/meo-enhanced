import assert from 'node:assert/strict';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';

const renderCalls: Array<[string, string]> = [];
const initializeCalls: Array<[string, string]> = [];
const pool = createMermaidDiagramRenderPool({
  async initialize(themeKey, configKey) {
    initializeCalls.push([themeKey, configKey]);
  },
  async render(renderId, source) {
    renderCalls.push([renderId, source]);
    return `<svg data-source="${source}"></svg>`;
  }
});

const [sharedA, sharedB] = await Promise.all([
  pool.render({
    rawSource: 'graph TD\nA-->B',
    normalizedSource: 'graph TD\nA-->B',
    themeKey: 'light',
    configKey: 'default'
  }),
  pool.render({
    rawSource: 'graph TD\nA-->B',
    normalizedSource: 'graph TD\nA-->B',
    themeKey: 'light',
    configKey: 'default'
  })
]);
assert.deepEqual(sharedA, sharedB);
assert.equal(sharedA.ok, true);
assert.equal(renderCalls.length, 1, 'identical real keys must share in-flight render');
assert.deepEqual(initializeCalls, [['light', 'default']]);

await pool.render({
  rawSource: 'graph TD\nA-->B\n',
  normalizedSource: 'graph TD\nA-->B',
  themeKey: 'light',
  configKey: 'default'
});
assert.equal(renderCalls.length, 2, 'raw source differences must remain distinct cache identities');

pool.dispose();

let releaseActive!: () => void;
const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
const priorityOrder: string[] = [];
const priorityPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() { return '<svg></svg>'; }
});
const activeOperation = priorityPool.runExclusive(async () => {
  priorityOrder.push('active');
  await activeGate;
}, 'normal');
const normalOne = priorityPool.runExclusive(async () => { priorityOrder.push('normal-1'); }, 'normal');
const highOne = priorityPool.runExclusive(async () => { priorityOrder.push('high-1'); }, 'high');
const normalTwo = priorityPool.runExclusive(async () => { priorityOrder.push('normal-2'); }, 'normal');
const highTwo = priorityPool.runExclusive(async () => { priorityOrder.push('high-2'); }, 'high');
releaseActive();
await Promise.all([activeOperation, normalOne, highOne, normalTwo, highTwo]);
assert.deepEqual(priorityOrder, ['active', 'high-1', 'high-2', 'normal-1', 'normal-2']);
priorityPool.dispose();

let errorRenderCount = 0;
let themeRefreshCount = 0;
const errorInitializations: string[] = [];
const errorPool = createMermaidDiagramRenderPool({
  initialize(themeKey, configKey) { errorInitializations.push(`${themeKey}:${configKey}`); },
  async render(_renderId, source) {
    errorRenderCount += 1;
    if (source === 'invalid') throw new Error('parse error');
    return `<svg data-source="${source}"></svg>`;
  }
});
const unsubscribeTheme = errorPool.subscribeThemeRefresh(() => { themeRefreshCount += 1; });
const invalidRequest = {
  rawSource: 'invalid', normalizedSource: 'invalid', themeKey: 'light', configKey: 'default'
} as const;
assert.deepEqual(await errorPool.render(invalidRequest), { ok: false, error: 'parse error' });
assert.deepEqual(await errorPool.render(invalidRequest), { ok: false, error: 'parse error' });
assert.equal(errorRenderCount, 1, 'error results remain cached until theme refresh');
errorPool.rememberHeight('estimated:diagram-a', 120);
errorPool.rememberHeight('preview:diagram-a', 140);
assert.equal(errorPool.getHeight('estimated:diagram-a'), 120);
assert.equal(errorPool.getHeight('preview:diagram-a'), 140);
errorPool.refreshTheme();
assert.equal(themeRefreshCount, 1);
assert.equal(errorPool.getHeight('estimated:diagram-a'), 120);
assert.equal(errorPool.getHeight('preview:diagram-a'), 140);
assert.deepEqual(await errorPool.render(invalidRequest), { ok: false, error: 'parse error' });
assert.equal(errorRenderCount, 2);
assert.deepEqual(errorInitializations, ['light:default', 'light:default']);
unsubscribeTheme();
errorPool.refreshTheme();
assert.equal(themeRefreshCount, 1, 'unsubscribed theme listeners must remain bounded');
errorPool.dispose();

let releaseCapacity!: () => void;
const capacityGate = new Promise<void>((resolve) => { releaseCapacity = resolve; });
const capacityPool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() { return '<svg></svg>'; },
  maxQueuedOperations: 1
});
const capacityActive = capacityPool.runExclusive(() => capacityGate);
const capacityQueued = capacityPool.runExclusive(async () => undefined);
await assert.rejects(
  capacityPool.runExclusive(async () => undefined),
  /queue capacity exceeded/
);
releaseCapacity();
await Promise.all([capacityActive, capacityQueued]);
capacityPool.dispose();

let releaseOldTheme!: () => void;
let releaseNewTheme!: () => void;
const oldThemeGate = new Promise<void>((resolve) => { releaseOldTheme = resolve; });
const newThemeGate = new Promise<void>((resolve) => { releaseNewTheme = resolve; });
let themeRaceRenderCount = 0;
const themeRacePool = createMermaidDiagramRenderPool({
  initialize() {},
  async render() {
    themeRaceRenderCount += 1;
    const generation = themeRaceRenderCount;
    await (generation === 1 ? oldThemeGate : newThemeGate);
    return `<svg data-generation="${generation}"></svg>`;
  }
});
const themeRaceRequest = {
  rawSource: 'same', normalizedSource: 'same', themeKey: 'light', configKey: 'default'
} as const;
const oldThemeRender = themeRacePool.render(themeRaceRequest);
await Promise.resolve();
themeRacePool.refreshTheme();
const newThemeRender = themeRacePool.render(themeRaceRequest);
releaseOldTheme();
await oldThemeRender;
while (themeRaceRenderCount < 2) await Promise.resolve();
const sharedNewThemeRender = themeRacePool.render(themeRaceRequest);
releaseNewTheme();
const [newThemeResult, sharedNewThemeResult] = await Promise.all([
  newThemeRender,
  sharedNewThemeRender
]);
assert.equal(themeRaceRenderCount, 2, 'old generation cleanup must not remove newer in-flight work');
assert.deepEqual(sharedNewThemeResult, newThemeResult, 'old generation result must not refill refreshed cache');
themeRacePool.dispose();

const never = new Promise<string>(() => undefined);
const disposalPool = createMermaidDiagramRenderPool({
  initialize() {},
  render: () => never
});
const activeRender = disposalPool.render({
  rawSource: 'never', normalizedSource: 'never', themeKey: 'light', configKey: 'default'
});
disposalPool.dispose();
const disposalOutcome = await Promise.race([
  activeRender,
  new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25))
]);
assert.deepEqual(disposalOutcome, { ok: false, error: 'Mermaid render Pool is disposed' });

console.log('Mermaid diagram Render Pool contracts passed');
