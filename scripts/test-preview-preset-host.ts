import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import exportRuntime from '../src/export/runtime';
import { PREVIEW_PRESET_STATE_KEY } from '../src/shared/preview';
import { decodeEditorCommand } from '../src/protocol/editorCommands';
import { getPreviewPreset, type PreviewPresetId } from '../src/foundation/previewPresets';
import { createPreviewPresetPreferences, PREVIEW_PRESET_PREFERENCES_STATE_KEY } from '../src/host/previewPresetPreferences';
import { createPanelSessionControllerParams, createPanelSessionTestDocument, createPanelSessionTestUri, createPanelSessionVscodeMock, panelSessionDisposable } from './panel-session-test-helper';

const document = createPanelSessionTestDocument(createPanelSessionTestUri('C:/tmp/preset-host.md'), 'first\nsecond');
mock.module('vscode', () => createPanelSessionVscodeMock(document));
const { createPanelSessionController } = await import('../src/extension/panelSession');
const { createPendingDraftRecovery } = await import('../src/application/pendingDraftRecovery');
const messages: any[] = [];
let receiveMessage: ((message: unknown) => void) | undefined;
const stored = new Map<string, unknown>();
let hiddenPresets: PreviewPresetId[] = [];
let defaultCodeFont = 'Consolas';
let failFonts = false;
const fontRequests: boolean[] = [];
const preferences = createPreviewPresetPreferences({
  readStored: () => stored.get(PREVIEW_PRESET_PREFERENCES_STATE_KEY),
  writeStored: async value => { stored.set(PREVIEW_PRESET_PREFERENCES_STATE_KEY, structuredClone(value)); },
  getPreset: id => id.startsWith('user:') ? undefined : getPreviewPreset(id)
});
const params = createPanelSessionControllerParams({
  panel: {
    active: true,
    webview: { postMessage: async (message: unknown) => { messages.push(message); return true; }, onDidReceiveMessage: (listener: (message: unknown) => void) => { receiveMessage = listener; return panelSessionDisposable(); } },
    onDidChangeViewState: () => panelSessionDisposable(), onDidDispose: () => panelSessionDisposable()
  },
  document,
  pendingDraftRecovery: createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: document.version, text: document.text }),
    applyDraft: async () => true,
    preserveConflict: async () => false
  }),
  readDiskText: () => document.text,
  overrides: {
    getPreviewFonts: async (refresh: boolean) => { fontRequests.push(refresh); if (failFonts) throw new Error('unavailable'); return [{ family: 'Consolas', aliases: [] }]; },
    getPreviewCodeFontFamily: () => defaultCodeFont,
    setPreviewCodeFontFamily: async (font: string) => { defaultCodeFont = font; },
    getPreviewPresetPreferences: preferences.read,
    getDisabledPreviewPresets: () => hiddenPresets,
    setPreviewPresetPreference: preferences.update,
    renderPreview: async (options: any) => exportRuntime.renderPreviewDocument(options),
    context: { globalState: { get: (key: string) => stored.get(key), update: async (key: string, value: unknown) => { stored.set(key, value); } } }
  }
});
const controller = createPanelSessionController(params as never);
try {
  await controller.handleMessage({ type: 'getPreviewFonts', requestId: 'font-success', refresh: true });
  assert.deepEqual(fontRequests, [true]);
  assert.deepEqual(messages.find(message => message.requestId === 'font-success').result, { ok: true, value: [{ family: 'Consolas', aliases: [] }] });
  failFonts = true;
  await controller.handleMessage({ type: 'getPreviewFonts', requestId: 'font-failure', refresh: false });
  assert.equal(messages.find(message => message.requestId === 'font-failure').result.ok, false);
  await controller.handleMessage({ type: 'setPreviewCodeFontFamily', fontFamily: 'Georgia' });
  assert.equal(defaultCodeFont, 'Georgia');
  const request = { type: 'requestPreviewRender', requestId: 'github', text: document.text, uiLanguage: 'en', environment: { previewFontFamily: 'Georgia', previewShowComments: true, previewSourceColoring: false }, preset: 'github-readme', contentWidth: 'reference' };
  receiveMessage!(request);
  await Bun.sleep(0);
  const github = messages.find(message => message.requestId === 'github').result.value;
  assert.equal(github.preset, 'github-readme');
  assert.ok(github.styles.light.includes('max-width: 1076px'));
  assert.ok(!github.html.includes('<br'));
  receiveMessage!({ ...request, requestId: 'default', preset: 'default', contentWidth: 'responsive' });
  await Bun.sleep(0);
  const original = messages.find(message => message.requestId === 'default').result.value;
  assert.equal(original.preset, 'default');
  assert.ok(original.html.includes('<br'));
  const count = messages.length;
  receiveMessage!({ ...request, requestId: 'invalid', preset: 'invalid' });
  await Bun.sleep(0);
  assert.equal(messages.length, count);
  await controller.handleMessage({ type: 'ready', pageId: 'preview-preset-page-1' });
  assert.equal(messages.findLast(message => message.type === 'init').previewPreset, undefined, 'An existing Webview can migrate its selection when Host memory is empty');
  assert.equal(messages.findLast(message => message.type === 'init').previewPresetPreferences, undefined);
  assert.equal(messages.findLast(message => message.type === 'init').previewCodeFontFamily, 'Georgia');
  const initialPreference = { appearance: 'auto', contentWidth: 'responsive', fontFamily: 'Arial', sourceColoring: false, showComments: true };
  await controller.handleMessage({ type: 'setPreviewPresetPreference', preset: 'whitey', preference: { appearance: 'dark' }, initialPreference });
  assert.deepEqual(decodeEditorCommand({ type: 'setPreviewPreset', preset: 'whitey' }), { type: 'setPreviewPreset', preset: 'whitey' });
  assert.equal(decodeEditorCommand({ type: 'setPreviewPreset', preset: 'invalid' }), null);
  await controller.handleMessage({ type: 'setPreviewPreset', preset: 'newsprint' });
  assert.equal(stored.get(PREVIEW_PRESET_STATE_KEY), 'newsprint');
  await controller.handleMessage({ type: 'setPreviewPreset', preset: 'user:missing' });
  assert.equal(stored.get(PREVIEW_PRESET_STATE_KEY), 'newsprint', 'Unknown custom presets cannot become the startup default');
  const restarted = createPanelSessionController(params as never);
  try {
    await restarted.handleMessage({ type: 'ready', pageId: 'preview-preset-page-2' });
    assert.equal(messages.findLast(message => message.type === 'init').previewPreset, 'newsprint', 'A new Host session restores the last selection');
    assert.deepEqual(messages.findLast(message => message.type === 'init').previewPresetPreferences.whitey, { ...initialPreference, appearance: 'dark' }, 'Init transmits every preset preference to a new document');
    await restarted.handleMessage({ type: 'setPreviewPresetPreference', preset: 'whitey', preference: { showComments: false }, initialPreference });
    await controller.handleMessage({ type: 'ready', pageId: 'preview-preset-page-1' });
    assert.equal(messages.findLast(message => message.type === 'init').previewPresetPreferences.whitey.showComments, false);
    stored.set(PREVIEW_PRESET_STATE_KEY, 'user:removed');
    await restarted.handleMessage({ type: 'ready', pageId: 'preview-preset-page-2' });
    assert.equal(messages.findLast(message => message.type === 'init').previewPreset, 'default', 'Removed presets fall back safely at startup');
    stored.set(PREVIEW_PRESET_STATE_KEY, 'whitey'); hiddenPresets = ['whitey'];
    await restarted.handleMessage({ type: 'ready', pageId: 'preview-preset-page-2' });
    assert.equal(messages.findLast(message => message.type === 'init').previewPreset, 'default', 'A hidden built-in falls back at startup');
    assert.deepEqual(messages.findLast(message => message.type === 'init').disabledPreviewPresets, ['whitey']);
    stored.set(PREVIEW_PRESET_STATE_KEY, 'default');
    await restarted.handleMessage({ type: 'setPreviewPreset', preset: 'whitey' });
    assert.equal(stored.get(PREVIEW_PRESET_STATE_KEY), 'default', 'A hidden built-in cannot become the startup selection');
    hiddenPresets = [];
    await restarted.handleMessage({ type: 'setPreviewPreset', preset: 'whitey' });
    assert.equal(stored.get(PREVIEW_PRESET_STATE_KEY), 'whitey', 'Showing a built-in makes it selectable again');
  } finally { restarted.dispose(); }
  console.log('Preview preset Host request forwarding and validation tests passed.');
} finally {
  controller.dispose();
}
