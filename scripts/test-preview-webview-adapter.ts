import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { HostToWebviewMessage } from '../src/protocol/messages';
import type { PreviewRenderResponse } from '../src/protocol/previewRender';
import { createPreviewWebviewAdapter } from '../webview/src/adapters/previewWebviewAdapter';

const calls: Array<{ type: string; [key: string]: unknown }> = [];
let appearance: 'dark' | 'light' = 'dark';
const surface = {
  setAppearance(next: 'dark' | 'light') {
    appearance = next;
    calls.push({ type: 'appearance', appearance: next });
  },
  getAppearance: () => appearance,
  setVisible(visible: boolean) {
    calls.push({ type: 'visible', visible });
  },
  preload(text: string) {
    calls.push({ type: 'preload', text });
  },
  requestRender(text: string, options: { restoreLine?: number | null } = {}) {
    calls.push({ type: 'render', text, restoreLine: options.restoreLine ?? null });
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
adapter.start({ text: 'hidden', appearance: 'dark', active: false });
assert.deepEqual(calls, [
  { type: 'appearance', appearance: 'dark' },
  { type: 'preload', text: 'hidden' }
]);

adapter.setActive({ active: true, text: 'visible', restoreLine: 3, initialAppearance: 'light' });
assert.deepEqual(calls.slice(2), [
  { type: 'visible', visible: true },
  { type: 'appearance', appearance: 'light' },
  { type: 'render', text: 'visible', restoreLine: 3 }
]);

adapter.setActive({ active: true, text: 'updated', restoreLine: null, initialAppearance: 'dark' });
assert.equal(calls.filter(call => call.type === 'appearance' && call.appearance === 'dark').length, 1);
adapter.refreshVisible('theme refresh');
assert.deepEqual(calls.at(-1), { type: 'render', text: 'theme refresh', restoreLine: 6 });
adapter.refreshVisible('explicit restore', { restoreLine: 9 });
assert.deepEqual(calls.at(-1), { type: 'render', text: 'explicit restore', restoreLine: 9 });

const response: PreviewRenderResponse = {
  type: 'previewRenderResult',
  requestId: 'preview-1',
  result: {
    ok: true,
    value: { html: '<p>ok</p>', hasMermaid: false, styles: { dark: '', light: '' } }
  }
};
assert.equal(adapter.accept(response), true);
assert.equal(adapter.accept({ type: 'previewAppearanceChanged', appearance: 'dark' }), true);
assert.equal(adapter.accept({ type: 'focusEditor' } as HostToWebviewMessage), false);
assert.equal(adapter.getAppearance(), 'dark');

adapter.setActive({ active: false, text: 'hidden again', initialAppearance: 'dark' });
const beforeHiddenRefresh = calls.length;
adapter.refreshVisible('must not render');
assert.equal(calls.length, beforeHiddenRefresh);
adapter.restoreActive(true);
assert.deepEqual(calls.at(-1), { type: 'visible', visible: true });
adapter.restoreActive(false);

adapter.dispose();
adapter.dispose();
const beforeDisposedActions = calls.length;
adapter.setActive({ active: true, text: 'ignored', initialAppearance: 'dark' });
adapter.refreshVisible('ignored');
assert.equal(adapter.accept(response), true);
assert.equal(calls.length, beforeDisposedActions);
assert.equal(calls.filter(call => call.type === 'dispose').length, 1);

const repoRoot = path.resolve(import.meta.dir, '..');
const bootstrap = fs.readFileSync(path.join(repoRoot, 'webview/src/index.ts'), 'utf8');
assert.equal((bootstrap.match(/createPreviewWebviewAdapter\s*\(/g) ?? []).length, 1);
assert.equal(bootstrap.includes('createPreviewRenderTransport'), false);
for (const forbiddenCall of [
  'previewController.requestRender',
  'previewController.preload',
  'previewController.acceptRenderResponse',
  'previewController.setVisible',
  'previewController.setAppearance'
]) {
  assert.equal(bootstrap.includes(forbiddenCall), false, `Preview lifecycle leaked into Bootstrap: ${forbiddenCall}`);
}
assert.match(bootstrap, /previewAdapter\.start\s*\(/);
assert.match(bootstrap, /previewAdapter\.accept\s*\(message\)/);
assert.match(bootstrap, /previewAdapter\.dispose\s*\(\s*\)/);

console.log('Preview Webview Adapter checks passed');
