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
  createPanelSessionTestUri('C:/reading-position.md'),
  '# title\nbody'
);
mock.module('vscode', () => createPanelSessionVscodeMock(document));

const [{ createPanelSessionController }, { createPendingDraftRecovery }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery')
]);

const createFixture = (hasExplicitNavigation: boolean) => {
  const messages: Array<Record<string, unknown>> = [];
  const remembered: Array<{ line: number; lineOffset: number }> = [];
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
  const pendingDraftRecovery = createPendingDraftRecovery({
    readCurrentText: () => document.text,
    applyDraft: async () => true
  });
  const controller = createPanelSessionController(createPanelSessionControllerParams({
    panel,
    document,
    pendingDraftRecovery,
    readDiskText: () => document.text,
    overrides: {
      viewNavigation: {
        hasPendingExplicitNavigation: () => hasExplicitNavigation,
        ready: async () => undefined,
        flush: async () => undefined,
        revealCurrentEditorSelection: async () => undefined,
        revealSelectionForEditor: async () => undefined,
        revealDocumentLink: async () => false,
        dispose: () => undefined
      },
      readingPosition: {
        readInitial: () => ({ line: 12, lineOffset: 3.5 }),
        remember: async (position: { line: number; lineOffset: number }) => {
          remembered.push(position);
        }
      }
    }
  }) as never);
  return { controller, messages, remembered };
};

const ordinary = createFixture(false);
await ordinary.controller.handleMessage({ type: 'ready' });
const ordinaryInit = ordinary.messages.find((message) => message.type === 'init');
assert.deepEqual(ordinaryInit?.readingPositionRestore, { line: 12, lineOffset: 3.5 });
assert.equal(ordinaryInit?.restoreReadingPositionOnOpen, true);
await ordinary.controller.handleMessage({
  type: 'readingPositionChanged',
  position: { line: 18, lineOffset: 2 }
});
assert.deepEqual(ordinary.remembered, [{ line: 18, lineOffset: 2 }]);
ordinary.controller.dispose();

const explicit = createFixture(true);
await explicit.controller.handleMessage({ type: 'ready' });
const explicitInit = explicit.messages.find((message) => message.type === 'init');
assert.equal(explicitInit?.readingPositionRestore, null, 'explicit navigation must win before Webview mount');
explicit.controller.dispose();

console.log('Panel Session reading position checks passed');
