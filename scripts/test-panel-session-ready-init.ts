import assert from 'node:assert/strict';
import { mock } from 'bun:test';
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
let releaseDiskRead: (() => void) | undefined;
const diskRead = new Promise<void>((resolve) => { releaseDiskRead = resolve; });
const panel = {
  active: true,
  webview: {
    postMessage: async (message: Record<string, unknown>) => {
      messages.push(message);
      return true;
    },
    onDidReceiveMessage: () => panelSessionDisposable()
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
    context: {
      globalState: {
        get: () => 'preview',
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
assert.equal(initMessages[0]?.text, '# Preview startup\n\nBody', 'initial Markdown must use the Webview editor line endings');
controller.dispose();

console.log('Panel Session ready/init single-flight checks passed');
