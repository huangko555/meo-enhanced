import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { HostToWebviewMessage } from '../src/protocol/messages';
import type { PreviewRenderResponse } from '../src/protocol/previewRender';
import { createPreviewWebviewAdapter } from '../webview/src/adapters/previewWebviewAdapter';

const calls: Array<{ type: string; [key: string]: unknown }> = [];
let appearance: 'dark' | 'light' = 'dark';
const surface = {
  setAppearance(next: 'auto' | 'dark' | 'light') {
    appearance = next === 'auto' ? 'dark' : next;
    calls.push({ type: 'appearance', appearance: next });
  },
  setSourceColoring(enabled: boolean) {
    calls.push({ type: 'sourceColoring', enabled });
  },
  setShowComments(enabled: boolean) {
    calls.push({ type: 'showComments', enabled });
  },
  setFontFamily(fontFamily: string) {
    calls.push({ type: 'fontFamily', fontFamily });
  },
  getAppearance: () => appearance,
  setVisible(visible: boolean) {
    calls.push({ type: 'visible', visible });
  },
  preload(text: string) {
    calls.push({ type: 'preload', text });
  },
  requestRender(text: string, options: {
    force?: boolean;
    preserveViewport?: boolean;
    preserveFrame?: boolean;
  } = {}) {
    calls.push({
      type: 'render',
      text,
      force: options.force === true,
      preserveViewport: options.preserveViewport === true,
      preserveFrame: options.preserveFrame === true
    });
  },
  acceptRenderResponse(message: PreviewRenderResponse) {
    calls.push({ type: 'response', requestId: message.requestId });
    return true;
  },
  getTopVisiblePosition: () => ({ topLine: 6, topLineOffset: 0 }),
  dispose() {
    calls.push({ type: 'dispose' });
  }
};

const adapter = createPreviewWebviewAdapter(surface);
adapter.start({ text: 'hidden', appearance: 'auto', fontFamily: 'MEO Synthetic Sans', sourceColoring: false, showComments: true, active: false });
assert.deepEqual(calls, [
  { type: 'appearance', appearance: 'auto' },
  { type: 'sourceColoring', enabled: false },
  { type: 'showComments', enabled: true },
  { type: 'fontFamily', fontFamily: 'MEO Synthetic Sans' },
  { type: 'preload', text: 'hidden' }
]);

adapter.setActive({ active: true, text: 'visible' });
assert.deepEqual(calls.slice(5), [
  { type: 'visible', visible: true },
  { type: 'render', text: 'visible', force: false, preserveViewport: false, preserveFrame: false }
]);

adapter.setActive({ active: true, text: 'updated' });
assert.deepEqual(calls.filter(call => call.type === 'appearance'), [
  { type: 'appearance', appearance: 'auto' }
]);
adapter.refreshVisible('theme refresh');
assert.deepEqual(calls.at(-1), {
  type: 'render', text: 'theme refresh', force: true, preserveViewport: true, preserveFrame: false
});
adapter.refreshVisible('external transaction', { preserveViewport: false });
assert.deepEqual(calls.at(-1), {
  type: 'render', text: 'external transaction', force: true, preserveViewport: false, preserveFrame: false
});
adapter.refreshVisible('font-size refresh', { preserveFrame: true });
assert.deepEqual(calls.at(-1), {
  type: 'render', text: 'font-size refresh', force: true, preserveViewport: true, preserveFrame: true
});

const response: PreviewRenderResponse = {
  type: 'previewRenderResult',
  requestId: 'preview-1',
  result: {
    ok: true,
    value: { html: '<p>ok</p>', hasMermaid: false, styles: { dark: '', light: '' } }
  }
};
assert.equal(adapter.accept(response), true);
assert.equal(adapter.accept({ type: 'previewAppearanceChanged', appearance: 'dark' } as HostToWebviewMessage), false);
assert.equal(adapter.accept({ type: 'previewSourceColoringChanged', enabled: true } as HostToWebviewMessage), false);
assert.equal(adapter.accept({ type: 'focusEditor' } as HostToWebviewMessage), false);
assert.equal(adapter.getAppearance(), 'dark');

adapter.setActive({ active: false, text: 'hidden again' });
const beforeHiddenRefresh = calls.length;
adapter.refreshVisible('must not render');
assert.equal(calls.length, beforeHiddenRefresh);
adapter.setActive({ active: true, text: 'must not render' });
assert.deepEqual(calls.at(-1), {
  type: 'render', text: 'must not render', force: true, preserveViewport: false, preserveFrame: false
}, 'settings changed while hidden invalidate the same-text render cache on activation');
adapter.setActive({ active: false, text: 'must not render' });
adapter.setActive({ active: true, text: 'must not render' });
assert.equal(calls.at(-1)?.force, false, 'unchanged mode switches still reuse the accepted render');

adapter.dispose();
adapter.dispose();
const beforeDisposedActions = calls.length;
adapter.setActive({ active: true, text: 'ignored' });
adapter.refreshVisible('ignored');
adapter.start({ text: 'ignored', appearance: 'light', fontFamily: '', sourceColoring: true, active: false });
assert.equal(adapter.accept(response), true);
assert.equal(calls.length, beforeDisposedActions);
assert.equal(calls.filter(call => call.type === 'dispose').length, 1);

const scheduled = new Map<number, () => void>();
let timerId = 0;
const scheduledRenders: string[] = [];
let finishRender: (() => void) | null = null;
let finishPreload: (() => void) | null = null;
const scheduledAdapter = createPreviewWebviewAdapter({
  ...surface,
  preload() {
    return new Promise<void>((resolve) => { finishPreload = resolve; });
  },
  setVisible() {},
  requestRender(text: string) {
    scheduledRenders.push(text);
    return new Promise<void>((resolve) => { finishRender = resolve; });
  },
  dispose() {}
}, {
  refreshDelayMs: 300,
  scheduleTimeout(callback) {
    const id = ++timerId;
    scheduled.set(id, callback);
    return id;
  },
  cancelTimeout(timeout) {
    scheduled.delete(timeout as number);
  }
});
scheduledAdapter.start({ text: 'hidden', appearance: 'auto', fontFamily: '', sourceColoring: true, active: false });
scheduledAdapter.scheduleVisibleRefresh('hidden edit');
assert.deepEqual(scheduledRenders, [], 'Hidden Source must not schedule Preview work');
assert.equal(scheduled.size, 0);

scheduledAdapter.setActive({ active: true, text: 'initial' });
scheduledAdapter.scheduleVisibleRefresh('draft 1');
scheduledAdapter.scheduleVisibleRefresh('draft 2');
assert.deepEqual(scheduledRenders, [], 'Opening must not race the existing hidden preload');
finishPreload?.();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(scheduledRenders, ['draft 2'], 'Only the latest Draft should follow an in-flight preload');
finishRender?.();
await Promise.resolve();
scheduledAdapter.scheduleVisibleRefresh('draft 3');
scheduledAdapter.scheduleVisibleRefresh('draft 4');
assert.equal(scheduled.size, 1, 'Typing should keep one coalescing timer');
const scheduledEntry = scheduled.entries().next().value;
if (scheduledEntry) {
  scheduled.delete(scheduledEntry[0]);
  scheduledEntry[1]();
}
assert.deepEqual(scheduledRenders, ['draft 2', 'draft 4']);
scheduledAdapter.setActive({ active: false, text: 'hidden' });
scheduledAdapter.scheduleVisibleRefresh('ignored');
assert.equal(scheduled.size, 0);
scheduledAdapter.dispose();

const resourceRenders: Array<{ text: string; force: boolean }> = [];
const catalogChanges: Array<{ selected: unknown; render: unknown }> = [];
let completeResourcePreload: (() => void) | undefined;
let completeResourceRender: (() => void) | undefined;
let resourceInvalidations = 0;
const resourceAdapter = createPreviewWebviewAdapter({
  ...surface,
  updateCustomPresets(_presets, selected, _initial, _diagnostics, options) {
    catalogChanges.push({ selected, render: options?.render });
  },
  invalidateRender() { resourceInvalidations += 1; },
  preload() { return new Promise<void>(resolve => { completeResourcePreload = resolve; }); },
  setVisible() {},
  requestRender(text, options) {
    resourceRenders.push({ text, force: options?.force === true });
    return new Promise<void>(resolve => { completeResourceRender = resolve; });
  },
  dispose() {}
});
resourceAdapter.start({ text: 'hidden', appearance: 'auto', fontFamily: '', sourceColoring: true, showComments: false, active: false });
resourceAdapter.invalidateResources('hidden resource update');
resourceAdapter.accept({ type: 'previewPresetsChanged', presets: [], selected: 'default', diagnostics: [] });
assert.deepEqual(catalogChanges.at(-1), { selected: 'default', render: false }, 'catalog changes update controls without starting a surface render');
assert.equal(resourceRenders.length, 0, 'hidden resource and catalog changes do not race an in-flight preload');
resourceAdapter.setActive({ active: true, text: 'active latest' });
assert.equal(resourceRenders.length, 0);
completeResourcePreload?.();
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(resourceRenders, [{ text: 'active latest', force: true }], 'activation cannot reuse a preload invalidated by external resources');
resourceAdapter.invalidateResources('resource update 1');
resourceAdapter.invalidateResources('resource update 2');
resourceAdapter.accept({ type: 'previewPresetsChanged', presets: [], selected: 'default', diagnostics: [] });
assert.equal(resourceRenders.length, 1, 'in-flight resource and catalog changes share the render queue');
completeResourceRender?.();
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(resourceRenders.at(-1), { text: 'resource update 2', force: true }, 'only the latest text is rendered after repeated invalidations');
resourceAdapter.dispose();
const disposedInvalidations = resourceInvalidations;
const disposedCatalogChanges = catalogChanges.length;
resourceAdapter.invalidateResources('disposed');
resourceAdapter.accept({ type: 'previewPresetsChanged', presets: [], diagnostics: [] });
assert.equal(resourceInvalidations, disposedInvalidations);
assert.equal(catalogChanges.length, disposedCatalogChanges);

// A settings update must retire a pending preload/result immediately, while
// the existing single-flight queue coalesces all changes until it settles.
for (const initialActive of [false, true]) {
  let complete: (() => void) | undefined;
  let invalidations = 0;
  const renders: Array<{ text: string; force: boolean; preserveFrame: boolean }> = [];
  const settingsAdapter = createPreviewWebviewAdapter({
    ...surface,
    preload: () => new Promise<void>(resolve => { complete = resolve; }),
    invalidateRender() { invalidations++; },
    requestRender(text, options) {
      renders.push({ text, force: options?.force === true, preserveFrame: options?.preserveFrame === true });
      return new Promise<void>(resolve => { complete = resolve; });
    },
    dispose() {}
  });
  settingsAdapter.start({ text: 'same text', appearance: 'auto', fontFamily: '', sourceColoring: true, showComments: false, active: initialActive });
  if (initialActive) settingsAdapter.setActive({ active: true, text: 'same text' });
  settingsAdapter.refreshVisible('same text', { preserveFrame: true });
  settingsAdapter.refreshVisible('same text', { preserveFrame: true });
  assert.equal(invalidations, 2, 'each environment update rejects the obsolete result before it can paint');
  assert.equal(renders.length, initialActive ? 1 : 0, 'settings updates do not race an in-flight render or preload');
  settingsAdapter.setActive({ active: false, text: 'same text' });
  complete?.();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(renders.length, initialActive ? 1 : 0, 'hiding cancels queued work without forgetting cache invalidation');
  settingsAdapter.setActive({ active: true, text: 'same text' });
  assert.deepEqual(renders.at(-1), { text: 'same text', force: true, preserveFrame: false });
  complete?.();
  await Promise.resolve(); await Promise.resolve();
  settingsAdapter.refreshVisible('same text', { preserveFrame: true });
  assert.deepEqual(renders.at(-1), { text: 'same text', force: true, preserveFrame: true }, 'visible appearance updates retain their frame-preservation policy');
  settingsAdapter.dispose();
}

const largeHiddenText = '# Large hidden preview\n\n' + 'Synthetic paragraph.\n\n'.repeat(5_000);
const largePreviewWork: string[] = [];
const largeAdapter = createPreviewWebviewAdapter({
  ...surface,
  preload() { largePreviewWork.push('preload'); },
  setVisible() {},
  requestRender(text) { largePreviewWork.push(text); },
  dispose() {}
});
largeAdapter.start({ text: largeHiddenText, appearance: 'auto', fontFamily: '', sourceColoring: true, showComments: false, active: false });
assert.deepEqual(largePreviewWork, [], 'opening a large document must not render its hidden Preview');
largeAdapter.setActive({ active: true, text: largeHiddenText + 'latest edit' });
assert.deepEqual(largePreviewWork, [largeHiddenText + 'latest edit'], 'Preview activation renders the latest full document on demand');
largeAdapter.dispose();

// A short complex document can use bounded DOM without inheriting the large
// document's cold-switch penalty. Its ordinary startup preload stays bounded.
const shortComplexText = ('| A | B |\n| --- | --- |\n| one | two |\n\n```js\nconst x = 1;\n```\n\n').repeat(100);
for (const [text, expected] of [[shortComplexText, 1], ['| A | B |\n| --- | --- |\n' + '| one | two |\n'.repeat(1200), 0]] as const) {
  let preloads = 0;
  const startup = createPreviewWebviewAdapter({ ...surface, preload() { preloads++; }, dispose() {} });
  startup.start({ text, appearance: 'auto', fontFamily: '', sourceColoring: true, showComments: false, active: false });
  assert.equal(preloads, expected, expected ? 'short bounded Preview retains one startup preload' : 'a giant single table skips hidden startup work');
  startup.dispose();
}

const repoRoot = path.resolve(import.meta.dir, '..');
const bootstrap = fs.readFileSync(path.join(repoRoot, 'webview/src/index.ts'), 'utf8');
assert.equal((bootstrap.match(/createPreviewWebviewAdapter\s*\(/g) ?? []).length, 1);
assert.equal(bootstrap.includes('createPreviewRenderTransport'), false);
for (const forbiddenCall of [
  'previewController.requestRender',
  'previewController.preload',
  'previewController.acceptRenderResponse',
  'previewController.setVisible',
  'previewController.setAppearance',
  'previewController.setFontFamily'
]) {
  assert.equal(bootstrap.includes(forbiddenCall), false, `Preview lifecycle leaked into Bootstrap: ${forbiddenCall}`);
}
assert.match(bootstrap, /previewAdapter\.start\s*\(/);
assert.doesNotMatch(bootstrap, /message\.previewAppearance\s*===/);
assert.doesNotMatch(bootstrap, /initialAppearance/);
assert.match(bootstrap, /previewAdapter\.accept\s*\(message\)/);
assert.match(bootstrap, /previewAdapter\.dispose\s*\(\s*\)/);

console.log('Preview Webview Adapter checks passed');
