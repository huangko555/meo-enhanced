import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable
} from './panel-session-test-helper';

const document = Object.assign(createPanelSessionTestDocument(
  createPanelSessionTestUri('C:/tab-navigation.md'), '# title\nbody'
), { offsetAt: (offset: number) => offset });
type NativeEditor = { document: typeof document; selection: { start: number; end: number } };
let onSelection!: (event: { textEditor: NativeEditor }) => void;
let onActiveEditor!: (editor: NativeEditor | undefined) => void;
let onVisibleEditors!: () => void;
const api = createPanelSessionVscodeMock(document);
const window = Object.assign(api.window as object, {
  activeTextEditor: undefined as NativeEditor | undefined,
  visibleTextEditors: [] as NativeEditor[],
  onDidChangeTextEditorSelection(listener: typeof onSelection) { onSelection = listener; return panelSessionDisposable(); },
  onDidChangeActiveTextEditor(listener: typeof onActiveEditor) { onActiveEditor = listener; return panelSessionDisposable(); },
  onDidChangeVisibleTextEditors(listener: typeof onVisibleEditors) { onVisibleEditors = listener; return panelSessionDisposable(); }
});
mock.module('vscode', () => api);
const [{ createPanelSessionController }, { createPendingDraftRecovery }, { createVscodeViewNavigationAdapter }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery'),
  import('../src/host/vscodeViewNavigationAdapter')
]);
const messages: Array<Record<string, unknown>> = [];
assert.equal(decodeWebviewToHostMessage({ type: 'requestWebviewVisibility', requestId: '' }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'webviewVisibilityResult', requestId: 'panel', visible: 1 }), null);
let onViewState!: (event: { webviewPanel: typeof panel }) => void;
const post = async (message: unknown) => { messages.push(message as Record<string, unknown>); return true; };
const panel = {
  active: true,
  visible: true,
  webview: { postMessage: post, onDidReceiveMessage: () => panelSessionDisposable() },
  onDidChangeViewState(listener: typeof onViewState) { onViewState = listener; return panelSessionDisposable(); },
  onDidDispose: () => panelSessionDisposable()
};
const controller = createPanelSessionController(createPanelSessionControllerParams({
  panel, document, readDiskText: () => document.text,
  pendingDraftRecovery: createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: document.version, text: document.text }),
    applyDraft: async () => true,
    preserveConflict: async () => false
  }),
  overrides: {
    viewNavigation: createVscodeViewNavigationAdapter({
      document: document as never, documentUri: document.uri as never,
      getDocumentFragmentHref: () => null, resolveLocalLinkTarget: async () => null, post
    })
  }
}) as never);
try {
  await controller.handleMessage({ type: 'ready', pageId: 'tab-navigation-page' });
  assert.equal(messages.filter(message => message.type === 'init').length, 1);
  assert.equal(messages.some(message => message.type === 'revealSelection'), false);
  await controller.handleMessage({ type: 'requestWebviewVisibility', requestId: 'visible-panel' });
  assert.deepEqual(messages.at(-1), { type: 'webviewVisibilityResult', requestId: 'visible-panel', visible: true });
  panel.visible = false;
  await controller.handleMessage({ type: 'requestWebviewVisibility', requestId: 'hidden-panel' });
  assert.deepEqual(messages.at(-1), { type: 'webviewVisibilityResult', requestId: 'hidden-panel', visible: false });
  panel.visible = true;
  const nativeEditor = { document, selection: { start: 0, end: 0 } };
  for (const offset of [0, 8]) {
    panel.active = false;
    panel.visible = false;
    onViewState({ webviewPanel: panel });
    nativeEditor.selection = { start: offset, end: offset };
    window.activeTextEditor = nativeEditor;
    window.visibleTextEditors = [nativeEditor];
    onActiveEditor(nativeEditor);
    onVisibleEditors();
    onSelection({ textEditor: nativeEditor });
    await Bun.sleep(0);
    window.activeTextEditor = undefined;
    window.visibleTextEditors = [];
    onActiveEditor(undefined);
    onVisibleEditors();
    panel.active = true;
    panel.visible = true;
    onViewState({ webviewPanel: panel });
    await Bun.sleep(0);
  }
  assert.deepEqual(messages.filter(message => message.type === 'revealSelection'), [
    { type: 'revealSelection', anchor: 0, head: 0, focus: false, preserveViewport: true },
    { type: 'revealSelection', anchor: 8, head: 8, focus: false, preserveViewport: true }
  ], 'native activation, visibility, Selection and MEO return must preserve the reading viewport');
  const otherEditor = { ...nativeEditor, document: { ...document, uri: createPanelSessionTestUri('C:/other.md') } };
  onActiveEditor(otherEditor);
  onSelection({ textEditor: otherEditor });
  await Bun.sleep(0);
  assert.equal(messages.filter(message => message.type === 'revealSelection').length, 2, 'another native document must not navigate MEO');
  assert.equal(messages.filter(message => message.type === 'init').length, 1, 'tab returns must not reinitialize the document');
  assert.equal(messages.filter(message => message.type === 'docChanged').length, 2);
  assert.equal(messages.filter(message => message.type === 'focusEditor').length, 2);
} finally { controller.dispose(); }
console.log('Panel Session native tab activation and reading viewport checks passed');
