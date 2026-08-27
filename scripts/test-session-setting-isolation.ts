import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable
} from './panel-session-test-helper';

const repoRoot = path.resolve(import.meta.dir, '..');
const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');

const configurationHandlerStart = extensionSource.indexOf('async handleConfigurationChanged(');
const configurationHandlerEnd = extensionSource.indexOf('\n  notifyVscodeCodeThemeChanged()', configurationHandlerStart);
if (configurationHandlerStart < 0 || configurationHandlerEnd < 0) {
  throw new Error('Could not locate the configuration-change handler');
}

const configurationHandler = extensionSource.slice(configurationHandlerStart, configurationHandlerEnd);
const sessionSettingBroadcasts = [
  'gitChangesGutterChanged',
  'gitDiffLineHighlightsChanged',
  'diffBaselineModeChanged',
  'contentMaxWidthChanged',
  'outlinePositionChanged',
  'outlineVisibilityChanged'
];

const leakedBroadcasts = sessionSettingBroadcasts.filter((messageType) => configurationHandler.includes(messageType));
if (leakedBroadcasts.length > 0) {
  throw new Error(`Persisted editor settings still broadcast to open sessions: ${leakedBroadcasts.join(', ')}`);
}

for (const methodName of ['setFindOptions', 'setOutlineVisible']) {
  const methodStart = extensionSource.indexOf(`private async ${methodName}(`);
  const methodEnd = extensionSource.indexOf('\n  private ', methodStart + 1);
  if (methodStart < 0 || methodEnd < 0) {
    throw new Error(`Could not locate ${methodName}`);
  }
  if (extensionSource.slice(methodStart, methodEnd).includes('this.broadcast(')) {
    throw new Error(`${methodName} still updates other open editor sessions`);
  }
}

const document = createPanelSessionTestDocument(
  createPanelSessionTestUri('C:/session-setting-isolation.md'),
  '# Settings isolation'
);
mock.module('vscode', () => createPanelSessionVscodeMock(document));
const { createPanelSessionController } = await import('../src/extension/panelSession');

const defaults = {
  previewAppearance: 'light' as 'light' | 'dark' | 'auto',
  previewFontFamily: '',
  previewSourceColoring: true,
  editorAppearance: 'light' as 'light' | 'dark' | 'auto'
};

const createPanel = () => {
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
    document,
    readDiskText: () => document.text,
    pendingDraftRecovery: {
      remember: (_text: string | null, version: number) => version,
      discardIfCurrent: () => true,
      recover: async () => false
    },
    overrides: {
      getPreviewAppearance: () => defaults.previewAppearance,
      setPreviewAppearance: async (value: typeof defaults.previewAppearance) => {
        defaults.previewAppearance = value;
      },
      getPreviewFontFamily: () => defaults.previewFontFamily,
      setPreviewFontFamily: async (value: string) => {
        defaults.previewFontFamily = value;
      },
      getPreviewSourceColoring: () => defaults.previewSourceColoring,
      setPreviewSourceColoring: async (value: boolean) => {
        defaults.previewSourceColoring = value;
      },
      getEditorAppearance: () => defaults.editorAppearance,
      setEditorAppearance: async (value: typeof defaults.editorAppearance) => {
        defaults.editorAppearance = value;
      }
    }
  }) as never);
  return { controller, messages };
};

const firstPanel = createPanel();
await firstPanel.controller.handleMessage({ type: 'ready' });
const firstInit = firstPanel.messages.find((message) => message.type === 'init');
assert.ok(firstInit, 'the first panel must receive its frozen Init settings');
const firstMessageCount = firstPanel.messages.length;

await firstPanel.controller.handleMessage({ type: 'setPreviewAppearance', appearance: 'dark' });
await firstPanel.controller.handleMessage({ type: 'setPreviewFontFamily', fontFamily: 'Inter' });
await firstPanel.controller.handleMessage({ type: 'setPreviewSourceColoring', enabled: false });
await firstPanel.controller.handleMessage({ type: 'setEditorAppearance', appearance: 'dark' });
assert.equal(
  firstPanel.messages.length,
  firstMessageCount,
  'persisted appearance defaults must not broadcast into the current panel'
);
assert.deepEqual(
  {
    previewAppearance: firstInit.previewAppearance,
    previewFontFamily: firstInit.previewFontFamily,
    previewSourceColoring: firstInit.previewSourceColoring,
    editorAppearance: firstInit.editorAppearance
  },
  {
    previewAppearance: 'light',
    previewFontFamily: '',
    previewSourceColoring: true,
    editorAppearance: 'light'
  },
  'the current panel must retain its original Init snapshot'
);

const secondPanel = createPanel();
await secondPanel.controller.handleMessage({ type: 'ready' });
const secondInit = secondPanel.messages.find((message) => message.type === 'init');
assert.ok(secondInit, 'a later panel must receive an Init snapshot');
assert.deepEqual(
  {
    previewAppearance: secondInit.previewAppearance,
    previewFontFamily: secondInit.previewFontFamily,
    previewSourceColoring: secondInit.previewSourceColoring,
    editorAppearance: secondInit.editorAppearance
  },
  {
    previewAppearance: 'dark',
    previewFontFamily: 'Inter',
    previewSourceColoring: false,
    editorAppearance: 'dark'
  },
  'persisted appearance changes must become defaults only for later panels'
);
firstPanel.controller.dispose();
secondPanel.controller.dispose();

console.log('session setting isolation checks passed');
