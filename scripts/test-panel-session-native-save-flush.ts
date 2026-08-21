import assert from 'node:assert/strict';
import { mock } from 'bun:test';

type Disposable = { dispose(): void };
type Message = Record<string, unknown>;

const disposable = (): Disposable => ({ dispose: () => undefined });
const cancelable = (): { cancel(): void } => ({ cancel: () => undefined });

type FakeUri = {
  readonly scheme: 'file';
  readonly fsPath: string;
  toString(): string;
};

type FakeDocument = {
  readonly uri: FakeUri;
  text: string;
  version: number;
  isDirty: boolean;
  getText(): string;
  positionAt(offset: number): { readonly offset: number };
};

const documentUri: FakeUri = {
  scheme: 'file',
  fsPath: 'C:/native-save-flush.md',
  toString: () => 'file:///native-save-flush.md'
};

const document: FakeDocument = {
  uri: documentUri,
  text: 'outer Draft\n\n| old |\n| --- |',
  version: 2,
  isDirty: true,
  getText() { return this.text; },
  positionAt(offset) { return { offset }; }
};

let diskText = 'accepted\n\n| old |\n| --- |';
let willSaveListener: ((event: {
  readonly document: FakeDocument;
  readonly reason: number;
  waitUntil(thenable: PromiseLike<unknown>): void;
}) => void) | null = null;
const didSaveListeners: Array<(savedDocument: FakeDocument) => void> = [];
const changeListeners: Array<(event: {
  readonly document: FakeDocument;
  readonly contentChanges: readonly { readonly text: string }[];
}) => void> = [];

class FakeRange {
  constructor(
    readonly start: { readonly offset: number },
    readonly end: { readonly offset: number }
  ) {}
}

class FakeWorkspaceEdit {
  replacement: { readonly text: string } | null = null;
  replace(_uri: FakeUri, _range: FakeRange, text: string): void {
    this.replacement = { text };
  }
}

const configuration = {
  get: <T>(_key: string, fallback?: T): T | undefined => fallback,
  inspect: () => undefined,
  update: async () => undefined
};

mock.module('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  Range: FakeRange,
  RelativePattern: class FakeRelativePattern {},
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  WorkspaceEdit: FakeWorkspaceEdit,
  Uri: {
    file: (fsPath: string): FakeUri => ({
      scheme: 'file',
      fsPath,
      toString: () => `file:///${fsPath.replace(/\\/g, '/')}`
    }),
    joinPath: (base: FakeUri, child: string): FakeUri => ({
      scheme: 'file',
      fsPath: `${base.fsPath}/${child}`,
      toString: () => `${base.toString()}/${child}`
    })
  },
  commands: { executeCommand: async () => undefined },
  extensions: { all: [] },
  languages: { onDidChangeDiagnostics: () => disposable() },
  window: {
    tabGroups: { activeTabGroup: { activeTab: { input: { uri: documentUri } } } },
    showWarningMessage: async () => undefined,
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    onDidChangeVisibleTextEditors: () => disposable()
  },
  workspace: {
    textDocuments: [document],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => configuration,
    onWillSaveTextDocument: (listener: typeof willSaveListener) => {
      willSaveListener = listener;
      return disposable();
    },
    onDidChangeTextDocument: (listener: (typeof changeListeners)[number]) => {
      changeListeners.push(listener);
      return disposable();
    },
    onDidSaveTextDocument: (listener: (typeof didSaveListeners)[number]) => {
      didSaveListeners.push(listener);
      return disposable();
    },
    createFileSystemWatcher: () => ({
      ...disposable(),
      onDidChange: () => disposable(),
      onDidCreate: () => disposable(),
      onDidDelete: () => disposable()
    }),
    applyEdit: async (edit: FakeWorkspaceEdit) => {
      if (!edit.replacement) return false;
      document.text = edit.replacement.text;
      document.version += 1;
      document.isDirty = true;
      for (const listener of changeListeners) {
        listener({ document, contentChanges: [{ text: document.text }] });
      }
      return true;
    },
    fs: {}
  }
}));

const [{ createPanelSessionController }, { createPendingDraftRecovery }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery')
]);

const postedToWebview: Message[] = [];
let receiveMessage: ((message: unknown) => void) | null = null;
let pendingTableCellText = 'outer Draft\n\n| pending cell |\n| --- |';

const panel = {
  active: true,
  webview: {
    postMessage: async (message: Message) => {
      postedToWebview.push(message);
      if (message.type === 'flushDocumentEdits') {
        const nextText = pendingTableCellText || document.text;
        pendingTableCellText = '';
        queueMicrotask(() => {
          receiveMessage?.({
            type: 'draftChanged',
            text: nextText,
            receiptVersion: 1
          });
          receiveMessage?.({
            type: 'applyChanges',
            baseVersion: document.version,
            changes: [{ from: 0, to: document.text.length, insert: nextText }]
          });
          receiveMessage?.({
            type: 'flushDocumentEditsResult',
            requestId: message.requestId,
            result: { ok: true, value: { text: nextText } }
          });
        });
      }
      return true;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receiveMessage = listener;
      return disposable();
    }
  },
  onDidChangeViewState: () => disposable(),
  onDidDispose: () => disposable()
};

const pendingDraftRecovery = createPendingDraftRecovery({
  readCurrentText: () => document.text,
  applyDraft: async (_expectedCurrentText, draftText) => {
    document.text = draftText;
    document.version += 1;
    document.isDirty = true;
    return true;
  }
});

async function nativeSave(): Promise<boolean> {
  const waiters: Promise<unknown>[] = [];
  willSaveListener?.({
    document,
    reason: 2,
    waitUntil(thenable) {
      waiters.push(Promise.resolve(thenable));
    }
  });
  await Promise.allSettled(waiters);
  diskText = document.text;
  document.isDirty = false;
  for (const listener of didSaveListeners) listener(document);
  return true;
}

const controller = createPanelSessionController({
  panel: panel as never,
  document: document as never,
  documentUri: documentUri as never,
  context: {
    globalState: { get: <T>(_key: string, fallback?: T): T | undefined => fallback, update: async () => undefined }
  } as never,
  diagnostics: { read: () => [] },
  agentReviewHandoff: { noteRecentMEOOwnedFileChangeForUri: () => undefined } as never,
  pendingDraftRecovery,
  gitBaselineRefreshTimer: { schedule: () => cancelable() },
  savedRevisionFile: { read: async () => ({ ok: true as const, text: diskText }) },
  savedRevisionRefreshTimer: { schedule: () => cancelable() },
  diffBaselineOutput: {
    hash: () => '',
    publish: async () => true,
    publishFixedState: async () => undefined
  },
  viewNavigation: {
    ready: async () => undefined,
    flush: async () => undefined,
    revealCurrentEditorSelection: async () => undefined,
    revealSelectionForEditor: async () => undefined,
    revealDocumentLink: async () => false,
    dispose: () => undefined
  },
  saveDocument: nativeSave,
  onExportDocument: async () => undefined,
  renderPreview: async () => ({ html: '', metadata: {} }) as never,
  getFindOptions: () => ({ wholeWord: false, caseSensitive: false }),
  setFindOptions: async () => undefined,
  getPreviewAppearance: () => 'light',
  setPreviewAppearance: async () => undefined,
  getPreviewSourceColoring: () => true,
  setPreviewSourceColoring: async () => undefined,
  getEditorAppearance: () => 'light',
  setEditorAppearance: async () => undefined,
  setOutlineVisible: async () => undefined,
  onPanelActivated: () => undefined,
  onPanelViewStateChanged: () => undefined,
  onPanelDisposed: () => undefined
});

await nativeSave();

assert.equal(
  diskText,
  'outer Draft\n\n| pending cell |\n| --- |',
  'VS Code auto/native save must flush a pending table cell through Document Session before disk write'
);
assert.equal(
  postedToWebview.some((message) => message.type === 'flushDocumentEdits'),
  true,
  'Host save lifecycle must request the production Webview transient-edit flush seam'
);

const nativeFlushCount = postedToWebview.filter((message) => message.type === 'flushDocumentEdits').length;
await controller.handleMessage({
  type: 'saveDocumentRevision',
  requestId: 'manual-save',
  revision: { version: document.version, text: document.text }
});
assert.equal(
  postedToWebview.filter((message) => message.type === 'flushDocumentEdits').length,
  nativeFlushCount,
  'MEO manual save must not re-enter the native flush handshake after Document Session prepared the exact Revision'
);

controller.dispose();
console.log('Panel Session native save flush checks passed');
