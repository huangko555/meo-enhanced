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
let onWindowState: ((state: { focused: boolean; active: boolean }) => void) | undefined;
const windowState = { focused: true, active: true };
mock.module('vscode', () => {
  const api = createPanelSessionVscodeMock(document, {
    onDidChangeWindowState(listener) {
      onWindowState = listener;
      return panelSessionDisposable();
    }
  });
  Object.assign(api.window as object, { state: windowState });
  return api;
});

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
const createController = () => createPanelSessionController(createPanelSessionControllerParams({
  panel,
  document,
  pendingDraftRecovery: createPendingDraftRecovery({
    readCurrentText: () => document.text,
    applyDraft: async () => true
  }),
  readDiskText: () => document.text
}) as never);
const controller = createController();
await controller.handleMessage({ type: 'ready' });
assert.ok(onWindowState, 'panel session did not subscribe to VS Code window focus changes');
const countFocusMessages = () => messages.filter((message) => message.type === 'focusEditor').length;
const emitWindowState = async (focused: boolean, active: boolean) => {
  Object.assign(windowState, { focused, active });
  onWindowState!({ focused, active });
  await Bun.sleep(0);
};
await emitWindowState(true, false);
await emitWindowState(true, true);
await emitWindowState(true, false);
assert.equal(countFocusMessages(), 0,
  'activity-only changes must not steal focus from another input or the command palette');
await emitWindowState(false, false);
assert.equal(countFocusMessages(), 0);
await emitWindowState(true, false);
assert.equal(countFocusMessages(), 1,
  'returning to a still-active panel should restore editor focus');
panel.active = false;
await emitWindowState(false, false);
await emitWindowState(true, true);
assert.equal(countFocusMessages(), 1,
  'inactive panels must not steal focus');
panel.active = true;
await emitWindowState(true, false);
assert.equal(countFocusMessages(), 1,
  'activity must not retry a focus return that occurred while the panel was inactive');
await emitWindowState(false, false);
await emitWindowState(true, true);
assert.equal(countFocusMessages(), 2, 'a later genuine focus return must still restore focus');
controller.dispose();
windowState.focused = false;
messages.length = 0;
const initiallyUnfocusedController = createController();
await initiallyUnfocusedController.handleMessage({ type: 'ready' });
await emitWindowState(false, false);
assert.equal(countFocusMessages(), 0);
await emitWindowState(true, false);
assert.equal(countFocusMessages(), 1,
  'a panel created while the window is unfocused must restore focus on its first return');
initiallyUnfocusedController.dispose();
console.log('Panel Session window focus transition and activity-only regression checks passed');
