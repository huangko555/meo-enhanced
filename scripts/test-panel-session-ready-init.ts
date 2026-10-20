import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { decodeInitMessage } from '../src/protocol/readyInit';
import type { UiColors } from '../src/foundation/uiColors';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable
} from './panel-session-test-helper';

const document = createPanelSessionTestDocument(
  createPanelSessionTestUri('C:/preview-startup.md'),
  '# Preview startup\r\n\r\nBody'
);
mock.module('vscode', () => createPanelSessionVscodeMock(document));

const [{ createPanelSessionController }, { createPendingDraftRecovery }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery')
]);

const messages: Array<Record<string, unknown>> = [];
let receiveMessage: ((value: unknown) => void) | undefined;
let colors: UiColors = { light: {}, dark: { accent: '#2277CC' } };
let failColors = false;
let concurrentColors: UiColors | undefined;
let releaseDiskRead: (() => void) | undefined;
let releaseImageHeaders!: () => void;
const imageHeaders = new Promise<void>(resolve => { releaseImageHeaders = resolve; });
let imageHeadersDisposed = false;
const dimensions = [{ src: 'picture.png', width: 640, height: 360 }];
const diskRead = new Promise<void>((resolve) => { releaseDiskRead = resolve; });
const panel = {
  active: true,
  webview: {
    postMessage: async (message: Record<string, unknown>) => {
      messages.push(message);
      return true;
    },
    onDidReceiveMessage: (receive: (value: unknown) => void) => { receiveMessage = receive; return panelSessionDisposable(); }
  },
  onDidChangeViewState: () => panelSessionDisposable(),
  onDidDispose: () => panelSessionDisposable()
};
const controller = createPanelSessionController(createPanelSessionControllerParams({
  panel,
  document,
  pendingDraftRecovery: createPendingDraftRecovery({
    readCurrentText: () => document.text,
    applyDraft: async () => true
  }),
  readDiskText: () => document.text,
  overrides: {
    imageDimensions: { snapshot: () => dimensions, ready: imageHeaders, dispose: () => { imageHeadersDisposed = true; } },
    getUiColors: () => colors,
    setUiColors: async (next: UiColors) => {
      if (failColors) throw new Error('fixture color write failure');
      colors = concurrentColors ?? next; return next;
    },
    context: {
      globalState: {
        get: <T>(key: string, fallback?: T): T | undefined => (key === 'editorMode' ? 'preview' : fallback) as T | undefined,
        update: async () => undefined
      }
    },
    savedRevisionFile: {
      read: async () => {
        await diskRead;
        return { ok: true, text: document.text };
      }
    }
  }
}) as never);

const readyMessages = [
  controller.handleMessage({ type: 'ready' }),
  controller.handleMessage({ type: 'ready' }),
  controller.handleMessage({ type: 'ready' })
];
releaseDiskRead?.();
await Promise.all(readyMessages);
assert.equal(messages.filter((message) => message.type === 'init').length, 1,
  'concurrent ready messages must share one pending init');
await controller.handleMessage({ type: 'ready' });
const initMessages = messages.filter((message) => message.type === 'init');
assert.equal(initMessages.length, 2, 'a later ready must retry an init lost during Webview startup');
assert.equal(initMessages[0]?.mode, 'preview');
assert.deepEqual(initMessages[0]?.imageIntrinsicSizes, dimensions, 'available headers travel with Init without waiting for the catalog');
releaseImageHeaders();
await Bun.sleep(0);
assert.ok(messages.some(message => message.type === 'imageIntrinsicSizes' && message.documentId === document.uri.toString()),
  'completed headers must publish after Init with document correlation');
assert.deepEqual(initMessages[0]?.uiColors, colors, 'initial handshake includes saved UI color profiles');
assert.equal(initMessages[0]?.text, '# Preview startup\n\nBody', 'initial Markdown must use the Webview editor line endings');
for (const message of initMessages) {
  const decoded = decodeInitMessage(message);
  assert.notEqual(decoded, null, 'the first and retried CRLF init must cross the actual Protocol decoder');
  assert.deepEqual(decoded?.savedRevision, { version: document.version, text: '# Preview startup\n\nBody' });
}
const requestedColors: UiColors = { light: { surface: '#F8F8F8' }, dark: { textEmphasis: '#99CCAA' } };
await controller.handleMessage({ type: 'updateUiColors', requestId: 'color-save', colors: requestedColors });
assert.deepEqual(messages.at(-2), { type: 'uiColorsChanged', colors: requestedColors });
assert.deepEqual(messages.at(-1), { type: 'uiColorsResult', requestId: 'color-save', result: { ok: true, value: requestedColors } });
const beforeInvalidColors = messages.length;
receiveMessage?.({ type: 'updateUiColors', requestId: 'invalid', colors: { dark: { text: 'red' } } });
assert.equal(messages.length, beforeInvalidColors, 'invalid color input is rejected before the owner');
failColors = true;
await controller.handleMessage({ type: 'updateUiColors', requestId: 'color-failure', colors: { light: {}, dark: {} } });
assert.deepEqual(messages.at(-1), { type: 'uiColorsResult', requestId: 'color-failure', result: { ok: false, error: { code: 'operation-failed', message: 'fixture color write failure' } } });
assert.deepEqual(colors, requestedColors, 'failed persistence does not change the current snapshot');
failColors = false; concurrentColors = { light: {}, dark: { accent: '#5588CC' } };
await controller.handleMessage({ type: 'updateUiColors', requestId: 'color-concurrent', colors: requestedColors });
assert.deepEqual(messages.at(-2), { type: 'uiColorsChanged', colors: concurrentColors }, 'delivery reads the latest owner snapshot instead of an earlier save result');
controller.dispose();
assert.equal(imageHeadersDisposed, true, 'disposing the panel must retire pending header reads');

const refreshedMessages: Array<Record<string, unknown>> = [];
let refresh: (() => void) | undefined;
let diskReads = 0;
const refreshedController = createPanelSessionController(createPanelSessionControllerParams({
  panel: {
    ...panel,
    webview: {
      ...panel.webview,
      postMessage: async (message: Record<string, unknown>) => { refreshedMessages.push(message); return true; }
    }
  },
  document,
  pendingDraftRecovery: createPendingDraftRecovery({
    readCurrentText: () => document.text,
    applyDraft: async () => true
  }),
  readDiskText: () => document.text,
  overrides: {
    savedRevisionFile: { read: async () => { diskReads += 1; return { ok: true, text: document.text }; } },
    savedRevisionRefreshTimer: {
      schedule: (_delay: number, task: () => void) => { refresh = task; return { cancel: () => undefined }; }
    }
  }
}) as never);
assert.ok(refresh, 'startup must schedule the disk refresh');
refresh();
await Bun.sleep(0);
await refreshedController.handleMessage({ type: 'ready' });
assert.equal(diskReads, 1, 'refresh-first init must reuse the populated Saved Revision tracker');
const refreshedInit = refreshedMessages.find(message => message.type === 'init');
assert.ok(refreshedInit);
const decodedRefreshedInit = decodeInitMessage(refreshedInit);
assert.notEqual(decodedRefreshedInit, null, 'refresh-first CRLF init must cross the actual Protocol decoder');
assert.deepEqual(decodedRefreshedInit?.savedRevision, { version: document.version, text: '# Preview startup\n\nBody' });
assert.equal(document.text, '# Preview startup\r\n\r\nBody', 'Protocol projection must preserve physical document text');
refreshedController.dispose();

console.log('Panel Session ready/init single-flight checks passed');
