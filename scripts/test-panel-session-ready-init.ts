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
const pageId = 'page_panel_ready';
let emitSaveStateChange: () => void = () => undefined;
let emitSave: () => void = () => undefined;
let latexSetting = false, failLatexWrite = false, folderLatexOverride = false;
const latexWrites: unknown[] = [];
mock.module('vscode', () => {
const mocked = createPanelSessionVscodeMock(document, {
  onDidChangeTextDocument(listener) {
    emitSaveStateChange = () => listener({ document, contentChanges: [] } as never);
    return panelSessionDisposable();
  },
  onDidSaveTextDocument(listener) {
    emitSave = () => listener(document as never);
    return panelSessionDisposable();
  }
});
Object.assign(mocked.ConfigurationTarget, { Workspace: 2, WorkspaceFolder: 3 });
Object.assign(mocked.workspace, {
  workspaceFolders: [{}],
  getConfiguration: (_section: string, _resource: unknown) => ({
    get: <T>(key: string, fallback: T): T | boolean => key === 'math.latexDelimiters' ? latexSetting : fallback,
    inspect: (key: string) => key === 'math.latexDelimiters' && folderLatexOverride ? { workspaceFolderValue: latexSetting } : undefined,
    update: async (key: string, value: boolean, target: number) => {
      if (key !== 'math.latexDelimiters') return;
      if (failLatexWrite) throw new Error('fixture math syntax write failure');
      latexWrites.push({ key, value, target }); latexSetting = value;
    }
  })
});
return mocked;
});

const [{ createPanelSessionController }, { createPendingDraftRecovery }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery')
]);

const messages: Array<Record<string, unknown>> = [];
let receiveMessage: ((value: unknown) => void) | undefined;
let colors: UiColors = { light: {}, dark: { accent: '#2277CC' } };
let failColors = false;
let lineHeight = 1.8;
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
    readCurrentRevision: () => ({ version: document.version, text: document.text }),
    applyDraft: async () => true,
    preserveConflict: async () => false
  }),
  readDiskText: () => document.text,
  overrides: {
    sidebarOutline: {
      setReady: (ready: boolean) => { messages.push({ type: 'sidebarReadiness', ready }); },
      update() {},
      dispose() {}
    },
    imageDimensions: { snapshot: () => dimensions, ready: imageHeaders, dispose: () => { imageHeadersDisposed = true; } },
    getEditorLineHeight: () => lineHeight,
    setEditorLineHeight: async (value: number) => { lineHeight = value; },
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
  controller.handleMessage({ type: 'ready', pageId }),
  controller.handleMessage({ type: 'ready', pageId }),
  controller.handleMessage({ type: 'ready', pageId })
];
assert.equal(messages.some(message => message.type === 'sidebarReadiness' && message.ready), false,
  'outline subscription remains gated while the real init is waiting on disk');
releaseDiskRead?.();
await Promise.all(readyMessages);
assert.ok(messages.findIndex(message => message.type === 'sidebarReadiness' && message.ready)
  > messages.findIndex(message => message.type === 'init'), 'Panel Session enables the outline only after init delivery');
assert.equal(messages.filter((message) => message.type === 'init').length, 1,
  'concurrent ready messages must share one pending init');
assert.ok(messages.some(message => message.type === 'documentSaveStateChanged'
  && message.isDirty === document.isDirty));
document.isDirty = false;
emitSaveStateChange();
await Bun.sleep(0);
assert.deepEqual(messages.filter(message => message.type === 'documentSaveStateChanged').at(-1), {
  type: 'documentSaveStateChanged', isDirty: false
}, 'a dirty-only transition (including undo) must publish without text edits');
document.isDirty = true;
emitSaveStateChange();
await Bun.sleep(0);
assert.equal(messages.filter(message => message.type === 'documentSaveStateChanged').at(-1)?.isDirty, true);
document.isDirty = false;
emitSave();
await Bun.sleep(0);
assert.equal(messages.filter(message => message.type === 'documentSaveStateChanged').at(-1)?.isDirty, false,
  'native saves must publish their actual dirty flag');
await controller.handleMessage({ type: 'ready', pageId });
const initMessages = messages.filter((message) => message.type === 'init');
assert.equal(initMessages.length, 2, 'a later ready must retry an init lost during Webview startup');
assert.equal(initMessages[0]?.mode, 'preview');
assert.deepEqual(initMessages[0]?.imageIntrinsicSizes, dimensions, 'available headers travel with Init without waiting for the catalog');
releaseImageHeaders();
await Bun.sleep(0);
assert.ok(messages.some(message => message.type === 'imageIntrinsicSizes' && message.documentId === document.uri.toString()),
  'completed headers must publish after Init with document correlation');
assert.equal(initMessages[0]?.editorLineHeight, 1.8);
assert.equal(decodeInitMessage({...initMessages[0], editorLineHeight: 0.8}), null);
await controller.handleMessage({type: 'setEditorLineHeight', value: 1.9});
assert.equal(lineHeight, 1.9, 'validated line spacing reaches the Host owner');
assert.deepEqual(initMessages[0]?.uiColors, colors, 'initial handshake includes saved UI color profiles');
assert.equal(initMessages[0]?.text, '# Preview startup\n\nBody', 'initial Markdown must use the Webview editor line endings');
for (const message of initMessages) {
  const decoded = decodeInitMessage(message);
  assert.notEqual(decoded, null, 'the first and retried CRLF init must cross the actual Protocol decoder');
  assert.deepEqual(decoded?.savedRevision, { version: document.version, text: '# Preview startup\n\nBody' });
}
const requestedColors: UiColors = { light: { surface: '#F8F8F8' }, dark: { textEmphasis: '#99CCAA' } };
assert.equal(decodeInitMessage(initMessages[0])?.latexDelimiters, false, 'new profiles preserve Markdown escapes');
await controller.handleMessage({ type: 'setLatexDelimiters', enabled: true });
assert.deepEqual(latexWrites.at(-1), { key: 'math.latexDelimiters', value: true, target: 2 }, 'the floating switch writes the workspace setting');
assert.deepEqual(messages.at(-1), { type: 'latexDelimitersChanged', enabled: true });
failLatexWrite = true;
await assert.rejects(controller.handleMessage({ type: 'setLatexDelimiters', enabled: false }), /fixture math syntax write failure/);
assert.deepEqual(messages.at(-1), { type: 'latexDelimitersChanged', enabled: true }, 'failed writes restore the authoritative setting');
failLatexWrite = false; folderLatexOverride = true;
await controller.handleMessage({ type: 'setLatexDelimiters', enabled: true });
assert.equal((latexWrites.at(-1) as { target: number }).target, 3, 'an existing folder override remains the setting owner');
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
    readCurrentRevision: () => ({ version: document.version, text: document.text }),
    applyDraft: async () => true,
    preserveConflict: async () => false
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
await refreshedController.handleMessage({ type: 'ready', pageId });
assert.equal(diskReads, 1, 'refresh-first init must reuse the populated Saved Revision tracker');
const refreshedInit = refreshedMessages.find(message => message.type === 'init');
assert.ok(refreshedInit);
const decodedRefreshedInit = decodeInitMessage(refreshedInit);
assert.equal(decodedRefreshedInit?.latexDelimiters, true, 'reopened editors read the saved syntax preference');
assert.notEqual(decodedRefreshedInit, null, 'refresh-first CRLF init must cross the actual Protocol decoder');
assert.deepEqual(decodedRefreshedInit?.savedRevision, { version: document.version, text: '# Preview startup\n\nBody' });
assert.equal(document.text, '# Preview startup\r\n\r\nBody', 'Protocol projection must preserve physical document text');
refreshedController.dispose();

let unavailableReads = 0;
let unavailableReason: 'too-large' | null = 'too-large';
const unavailablePublications: Array<{ kind: string }> = [];
const unavailableController = createPanelSessionController(createPanelSessionControllerParams({
  panel, document,
  pendingDraftRecovery: createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: document.version, text: document.text }),
    applyDraft: async () => true,
    preserveConflict: async () => false
  }),
  readDiskText: () => document.text,
  overrides: {
    savedRevisionFile: { read: async () => {
      unavailableReads++;
      // Bound the broken feedback loop so this contract fails without starving
      // the event loop when an unchanged unavailable read republishes itself.
      if (unavailableReads > 6) return new Promise(() => {});
      return unavailableReason ? { ok: false, reason: unavailableReason } : { ok: true, text: document.text };
    } },
    diffBaselineOutput: {
      hash: (selection: unknown) => JSON.stringify(selection),
      publish: async (selection: { kind: string }) => { unavailablePublications.push(selection); return true; },
      publishFixedState: async () => undefined
    }
  }
}) as never);
try {
  await unavailableController.handleMessage({ type: 'ready', pageId });
  unavailableController.session.refreshGitBaseline({ forcePost: true });
  for (let index = 0; index < 160; index++) await Promise.resolve();
  assert.ok(unavailableReads <= 2, 'an unavailable initial Saved Revision must not recursively refresh its own comparison');
  const beforeRetry = unavailableReads;
  unavailableController.session.refreshGitBaseline({ forcePost: true });
  for (let index = 0; index < 80; index++) await Promise.resolve();
  assert.equal(unavailableReads, beforeRetry + 1, 'an explicit retry still reads an unavailable baseline again');
  unavailableReason = null;
  unavailableController.session.refreshGitBaseline({ forcePost: true });
  for (let index = 0; index < 100; index++) await Promise.resolve();
  assert.ok(unavailablePublications.some(selection => selection.kind === 'saved'), 'a later readable file recovers comparison');
} finally { unavailableController.dispose(); }

console.log('Panel Session ready/init single-flight checks passed');
