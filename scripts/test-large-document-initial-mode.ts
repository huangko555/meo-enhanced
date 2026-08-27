import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable
} from './panel-session-test-helper';
import { createLargeDocumentFixtures } from './large-document-fixtures';

const fixtures = new Map(createLargeDocumentFixtures().map((fixture) => [fixture.kind, fixture.text]));
const document = createPanelSessionTestDocument(
  createPanelSessionTestUri('C:/large-document-initial-mode.md'),
  fixtures.get('ordinary')!
);
let optimizationEnabled = true;
const vscodeMock = createPanelSessionVscodeMock(document);
(vscodeMock.workspace as Record<string, unknown>).getConfiguration = () => ({
  get: <T>(key: string, fallback?: T): T | undefined => key === 'performance.largeDocumentOptimization'
    ? optimizationEnabled as T
    : fallback,
  inspect: () => undefined,
  update: async () => undefined
});
mock.module('vscode', () => vscodeMock);

const { createPanelSessionController } = await import('../src/extension/panelSession');
const persisted = new Map<string, unknown>();
const context = {
  globalState: {
    get: <T>(key: string, fallback?: T): T | undefined => persisted.has(key)
      ? persisted.get(key) as T
      : fallback,
    update: async (key: string, value: unknown) => { persisted.set(key, value); }
  }
};

const openPanel = async (text: string, targetDocument = document) => {
  targetDocument.text = text;
  targetDocument.version += 1;
  const messages: Array<Record<string, unknown>> = [];
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
    document: targetDocument,
    readDiskText: () => targetDocument.text,
    pendingDraftRecovery: {
      remember: (_text: string | null, version: number) => version,
      discardIfCurrent: () => true,
      recover: async () => false
    },
    overrides: { context }
  }) as never);
  await controller.handleMessage({ type: 'ready' });
  const init = messages.find((message) => message.type === 'init');
  assert.ok(init, 'the Host must deliver one Init snapshot');
  assert.equal(init.text, text, 'the policy and Init must use the same frozen text');
  return { controller, init };
};

optimizationEnabled = true;
const ordinary = await openPanel(fixtures.get('ordinary')!);
assert.equal(ordinary.init.mode, 'live');
ordinary.controller.dispose();

const automaticSource = await openPanel(fixtures.get('composite')!);
assert.equal(automaticSource.init.mode, 'source', 'an unpreferred large document must open silently in Source');
await automaticSource.controller.handleMessage({ type: 'setMode', mode: 'live' });
automaticSource.controller.dispose();

const manualLive = await openPanel(fixtures.get('composite')!);
assert.equal(manualLive.init.mode, 'live', 'a manual Live preference must beat later automatic decisions');
manualLive.controller.dispose();

const otherLargeDocument = createPanelSessionTestDocument(
  createPanelSessionTestUri('C:/other-large-document.md'),
  fixtures.get('composite')!
);
const isolatedAutomaticSource = await openPanel(fixtures.get('composite')!, otherLargeDocument);
assert.equal(
  isolatedAutomaticSource.init.mode,
  'source',
  'manual Live intent from one document must not disable optimization in another document'
);
isolatedAutomaticSource.controller.dispose();

persisted.clear();
optimizationEnabled = false;
const disabled = await openPanel(fixtures.get('composite')!);
assert.equal(disabled.init.mode, 'live', 'disabling optimization must retain the Live default');
disabled.controller.dispose();

persisted.set('editorMode', 'preview');
optimizationEnabled = true;
const otherDocumentPreview = await openPanel(fixtures.get('composite')!);
assert.equal(otherDocumentPreview.init.mode, 'source', 'another document Preview preference must not bypass optimization');
await otherDocumentPreview.controller.handleMessage({ type: 'setMode', mode: 'preview' });
otherDocumentPreview.controller.dispose();
const manualPreview = await openPanel(fixtures.get('composite')!);
assert.equal(manualPreview.init.mode, 'preview', 'this document manual Preview preference must retain precedence');
manualPreview.controller.dispose();

console.log('Large document initial mode production checks passed');
