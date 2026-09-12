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
adapter.start({ text: 'hidden', appearance: 'auto', fontFamily: 'MEO Synthetic Sans', sourceColoring: false, active: false });
assert.deepEqual(calls, [
  { type: 'appearance', appearance: 'auto' },
  { type: 'sourceColoring', enabled: false },
  { type: 'fontFamily', fontFamily: 'MEO Synthetic Sans' },
  { type: 'preload', text: 'hidden' }
]);

adapter.setActive({ active: true, text: 'visible' });
assert.deepEqual(calls.slice(4), [
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
