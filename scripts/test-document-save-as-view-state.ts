// Exercise native replacement before and after the Save As command resolves.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { URI } from 'vscode-uri';
import { createPanelSessionControllerParams, createPanelSessionTestDocument,
  createPanelSessionVscodeMock, panelSessionDisposable } from './panel-session-test-helper';
import { createDocumentSaveAsViewStateHandoff } from '../src/application/documentSaveAsViewState';
import { createHostViewNavigationLifecycle } from '../src/application/hostViewNavigationLifecycle';
const text = Array.from({ length: 500 }, (_, index) => `Reading line ${index + 1}`).join('\n');
const source = Object.assign(createPanelSessionTestDocument(URI.parse('file:///diagnostic/original.md') as never, text), { isUntitled: false, lineCount: 500 });
const target = Object.assign(createPanelSessionTestDocument(URI.parse('file:///diagnostic/new.md') as never, text), { isUntitled: false, lineCount: 500 });
class TabInputText { constructor(readonly uri: URI) {} }
class TabInputCustom { constructor(readonly uri: URI, readonly viewType: string) {} }
const group: any = { tabs: [], activeTab: undefined };
group.activeTab = { input: new TabInputCustom(source.uri as never, 'meoEnhanced.editor'), group };
group.tabs = [group.activeTab];
const saved = new Set<(doc: unknown) => void>();
const saving = new Set<(event: unknown) => void>();
let targetFixture: ReturnType<typeof fixture> | undefined;
let nextPageId = 0;
let nativeMEO = true;
let memoryEnabled = false;
const handoff = createDocumentSaveAsViewStateHandoff();
const base: any = createPanelSessionVscodeMock(source);
base.TabInputText = TabInputText; base.TabInputCustom = TabInputCustom;
base.window.tabGroups = { activeTabGroup: group, all: [group] };
base.workspace.onDidSaveTextDocument = (listener: any) => { saved.add(listener); return { dispose: () => saved.delete(listener) }; };
base.workspace.onWillSaveTextDocument = (listener: any) => { saving.add(listener); return { dispose: () => saving.delete(listener) }; };
base.commands.executeCommand = async (command: string) => {
  if (command === 'workbench.action.files.saveAs') {
    for (const listener of saving) listener({ document: target, reason: 1, waitUntil() {} });
    for (const listener of saved) listener(target);
    group.activeTab = { input: new TabInputCustom(target.uri as never, 'meoEnhanced.editor'), group };
    group.tabs = [group.activeTab];
    // Native replacement can initialize the new MEO before the command resolves.
    if (nativeMEO) {
      targetFixture = fixture(target);
      await targetFixture.controller.handleMessage({ type: 'ready', pageId: targetFixture.pageId });
    }
    return;
  }
  assert.equal(command, 'vscode.openWith');
  if (!targetFixture) {
    targetFixture = fixture(target);
    await targetFixture.controller.handleMessage({ type: 'ready', pageId: targetFixture.pageId });
  }
};
mock.module('vscode', () => base);
const [{ createPanelSessionController }, { createPendingDraftRecovery }, { createVscodeReadingPositionAdapter }] = await Promise.all([
  import('../src/extension/panelSession'), import('../src/application/pendingDraftRecovery'),
  import('../src/host/vscodeReadingPositionAdapter')
]);
const state = new Map<string, unknown>();
const workspaceState = { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } };
function fixture(document: typeof source) {
  const pageId = `save-as-page-${++nextPageId}`;
  const messages: any[] = [];
  const panel = { active: true, webview: {
    postMessage: async (message: unknown) => { messages.push(message); return true; },
    onDidReceiveMessage: () => panelSessionDisposable()
  }, onDidChangeViewState: () => panelSessionDisposable(), onDidDispose: () => panelSessionDisposable() };
  const params: any = createPanelSessionControllerParams({ panel, document,
    pendingDraftRecovery: createPendingDraftRecovery({
      readCurrentRevision: () => ({ version: document.version, text }),
      applyDraft: async () => true,
      preserveConflict: async () => false
    }),
    readDiskText: () => text
  });
  params.context.workspaceState = workspaceState;
  params.readingPosition = createVscodeReadingPositionAdapter(params.context, document as never, () => memoryEnabled);
  params.saveAsViewStateHandoff = handoff;
  const navigation = createHostViewNavigationLifecycle({
    initialSelection: { anchor: 0, head: 0 }, initialFragment: null,
    output: { reveal: async reveal => { messages.push({ type: 'revealSelection', ...reveal }); return true; } }
  });
  params.viewNavigation = { ...params.viewNavigation, ...navigation,
    revealCurrentEditorSelection: () => navigation.revealSelection({ anchor: 0, head: 0 }) };
  return { messages, pageId, controller: createPanelSessionController(params) };
}
const position = { line: 250, lineOffset: 17 };
const viewState = { mode: 'source' as const, position, selection: { anchor: 1200, head: 1220 } };
for (nativeMEO of [true, false]) for (memoryEnabled of [true, false]) {
  targetFixture = undefined;
  group.activeTab = { input: new TabInputCustom(source.uri as never, 'meoEnhanced.editor'), group };
  group.tabs = [group.activeTab];
  const original = fixture(source);
  await original.controller.handleMessage({ type: 'ready', pageId: original.pageId });
  await original.controller.handleMessage({ type: 'readingPositionChanged', position });
  await original.controller.handleMessage({ type: 'saveDocumentAs', requestId: 'save-as-position', text, viewState });
  assert.ok(targetFixture);
  const init = targetFixture.messages.find(message => message.type === 'init');
  assert.equal(init?.mode, 'source');
  assert.deepEqual(init?.saveAsViewState, viewState, 'the destination must receive its view state with its first init');
  assert.equal(targetFixture.messages.filter(message => message.type === 'revealSelection').length, 0,
    'the replaced native editor must not reveal its old selection over the Save As view');
  assert.equal(handoff.take(target.uri.toString(), text), null, 'a consumed state must not leak into a later open');
  original.controller.dispose(); targetFixture.controller.dispose();
}
const release = handoff.stage(target.uri.toString(), text, viewState);
assert.equal(handoff.take(target.uri.toString(), `${text} changed`), null, 'different content must not inherit a view');
release();
assert.equal(handoff.take(target.uri.toString(), text), null, 'an abandoned operation must release its state');
console.log('Save As first-init view-state handoff passed for native MEO/default editors with opening-position memory on/off');
