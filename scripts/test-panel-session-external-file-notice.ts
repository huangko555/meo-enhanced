import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionCancelable,
  panelSessionDisposable
} from './panel-session-test-helper';

const documentUri = createPanelSessionTestUri('C:/external-file-notice.md');
const document = createPanelSessionTestDocument(documentUri, 'base', 1, false);
let diskText = 'base';
let readFailure = false;
let fileChanged = (): void => undefined;
let fileCreated = (): void => undefined;
let fileDeleted = (): void => undefined;
let documentSaved = (): void => undefined;

mock.module('vscode', () => createPanelSessionVscodeMock(document, {
  onDidSaveTextDocument: (listener) => {
    documentSaved = () => listener(document as never);
    return panelSessionDisposable();
  },
  createFileSystemWatcher: () => ({
    ...panelSessionDisposable(),
    onDidChange(listener) {
      fileChanged = () => listener(documentUri as never);
      return panelSessionDisposable();
    },
    onDidCreate(listener) {
      fileCreated = () => listener(documentUri as never);
      return panelSessionDisposable();
    },
    onDidDelete(listener) {
      fileDeleted = () => listener(documentUri as never);
      return panelSessionDisposable();
    }
  })
}));

const [{ createPanelSessionController }, { createPendingDraftRecovery }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery')
]);

const posted: Array<Record<string, unknown>> = [];
const panel = {
  active: true,
  webview: {
    postMessage: async (message: Record<string, unknown>) => {
      posted.push(message);
      return true;
    },
    onDidReceiveMessage: () => panelSessionDisposable()
  },
  onDidChangeViewState: () => panelSessionDisposable(),
  onDidDispose: () => panelSessionDisposable()
};
const pendingDraftRecovery = createPendingDraftRecovery({
  readCurrentText: () => document.text,
  applyDraft: async () => true
});
const immediateTimer = {
  schedule(_delayMs: number, run: () => void) {
    let canceled = false;
    queueMicrotask(() => { if (!canceled) run(); });
    return { cancel: () => { canceled = true; } };
  }
};
const controller = createPanelSessionController(createPanelSessionControllerParams({
  panel,
  document,
  pendingDraftRecovery,
  readDiskText: () => diskText,
  overrides: {
    savedRevisionRefreshTimer: immediateTimer,
    savedRevisionFile: { read: async () => readFailure
      ? { ok: false as const, reason: 'error' as const }
      : { ok: true as const, text: diskText } },
    gitBaselineRefreshTimer: { schedule: () => panelSessionCancelable() }
  }
}) as never);

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};
const statuses = (): string[] => posted
  .filter((message) => message.type === 'externalFileStatusChanged')
  .map((message) => String(message.status));

await controller.handleMessage({ type: 'ready' });
posted.length = 0;

document.text = 'local edit';
document.version += 1;
document.isDirty = true;
diskText = 'external edit';
fileChanged();
await flushMicrotasks();
assert.deepEqual(statuses(), ['modified-while-dirty']);

fileChanged();
await flushMicrotasks();
assert.deepEqual(statuses(), ['modified-while-dirty'], 'duplicate watcher events must not repeat one disk Revision');

document.text = diskText;
document.isDirty = false;
fileChanged();
await flushMicrotasks();
assert.deepEqual(statuses(), ['modified-while-dirty', 'current']);

document.text = 'own save';
document.isDirty = true;
diskText = 'own save';
fileChanged();
await flushMicrotasks();
assert.deepEqual(statuses(), ['modified-while-dirty', 'current'], 'matching disk text must not be reported as external');

diskText = 'second external edit';
fileChanged();
await flushMicrotasks();
fileDeleted();
await flushMicrotasks();
assert.deepEqual(statuses(), [
  'modified-while-dirty',
  'current',
  'modified-while-dirty',
  'deleted-while-dirty'
]);

diskText = 'second external edit';
fileCreated();
await flushMicrotasks();
assert.equal(
  statuses().at(-1),
  'modified-while-dirty',
  'recreating the previous disk Revision must replace the stale deletion warning'
);

document.isDirty = false;
diskText = document.text;
documentSaved();
await flushMicrotasks();
assert.equal(statuses().at(-1), 'current', 'a successful save must clear the external-file warning');

document.text = 'unpublished local edit';
document.isDirty = true;
readFailure = true;
fileChanged();
await flushMicrotasks();
assert.equal(statuses().at(-1), 'unreadable-while-dirty',
  'a failed disk read with unsaved content must expose a recovery action');
readFailure = false;
diskText = document.text;
fileChanged();
await flushMicrotasks();
assert.equal(statuses().at(-1), 'current', 'a successful disk read must clear the unavailable state');
controller.dispose();
console.log('Panel Session external file notice checks passed');
