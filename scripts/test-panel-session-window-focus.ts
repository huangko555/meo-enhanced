import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable
} from './panel-session-test-helper';

const document = createPanelSessionTestDocument(createPanelSessionTestUri('C:/focus-return.md'), 'Body');
let onWindowState: ((state: { focused: boolean; active?: boolean }) => void) | null = null;
mock.module('vscode', () => createPanelSessionVscodeMock(document, {
  onDidChangeWindowState(listener) {
    onWindowState = listener;
    return panelSessionDisposable();
  }
}));

const [{ createPanelSessionController }, { createPendingDraftRecovery }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery')
]);
const messages: Array<Record<string, unknown>> = [];
const panel = {
  active: true,
  webview: {
    postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; },
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
  readDiskText: () => document.text
}) as never);
await controller.handleMessage({ type: 'ready' });
assert.ok(onWindowState, 'panel session did not subscribe to VS Code window focus changes');
onWindowState({ focused: true, active: false });
await Bun.sleep(0);
assert.equal(messages.filter((message) => message.type === 'focusEditor').length, 0,
  'activity-only changes must not steal focus from VS Code menus');
onWindowState({ focused: true, active: true });
await Bun.sleep(0);
assert.equal(messages.filter((message) => message.type === 'focusEditor').length, 0);
onWindowState({ focused: false });
await Bun.sleep(0);
assert.equal(messages.filter((message) => message.type === 'focusEditor').length, 0);
onWindowState({ focused: true });
await Bun.sleep(0);
assert.equal(messages.filter((message) => message.type === 'focusEditor').length, 1,
  'returning to a still-active panel should restore editor focus');
panel.active = false;
onWindowState({ focused: true });
await Bun.sleep(0);
assert.equal(messages.filter((message) => message.type === 'focusEditor').length, 1,
  'inactive panels must not steal focus');
controller.dispose();
console.log('Panel Session window focus checks passed');
