export type PanelSessionTestDisposable = { dispose(): void };

export type PanelSessionTestUri = {
  readonly scheme: 'file';
  readonly fsPath: string;
  toString(): string;
};

export type PanelSessionTestDocument = {
  readonly uri: PanelSessionTestUri;
  text: string;
  version: number;
  isDirty: boolean;
  getText(): string;
  positionAt(offset: number): { readonly offset: number };
};

export const panelSessionDisposable = (): PanelSessionTestDisposable => ({ dispose: () => undefined });
export const panelSessionCancelable = (): { cancel(): void } => ({ cancel: () => undefined });

export const createPanelSessionTestUri = (fsPath: string): PanelSessionTestUri => ({
  scheme: 'file',
  fsPath,
  toString: () => `file:///${fsPath.replace(/\\/g, '/')}`
});

export const createPanelSessionTestDocument = (
  uri: PanelSessionTestUri,
  text: string,
  version = 1,
  isDirty = true
): PanelSessionTestDocument => ({
  uri,
  text,
  version,
  isDirty,
  getText() { return this.text; },
  positionAt(offset) { return { offset }; }
});

type VscodeMockOverrides = {
  readonly Range?: new (...args: never[]) => unknown;
  readonly WorkspaceEdit?: new (...args: never[]) => unknown;
  readonly executeCommand?: (command: string) => Promise<unknown>;
  readonly onWillSaveTextDocument?: (listener: (event: never) => void) => PanelSessionTestDisposable;
  readonly onDidChangeTextDocument?: (listener: (event: never) => void) => PanelSessionTestDisposable;
  readonly onDidSaveTextDocument?: (listener: (document: never) => void) => PanelSessionTestDisposable;
  readonly applyEdit?: (edit: never) => Promise<boolean>;
  readonly showWarningMessage?: (message: string) => Promise<unknown>;
};

/** Basic VS Code shell shared only by PanelSession integration tests. */
export const createPanelSessionVscodeMock = (
  document: PanelSessionTestDocument,
  overrides: VscodeMockOverrides = {}
): Record<string, unknown> => ({
  ConfigurationTarget: { Global: 1 },
  Range: overrides.Range ?? class PanelSessionTestRange {},
  RelativePattern: class PanelSessionTestRelativePattern {},
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  WorkspaceEdit: overrides.WorkspaceEdit ?? class PanelSessionTestWorkspaceEdit {},
  Uri: {
    file: createPanelSessionTestUri,
    joinPath: (base: PanelSessionTestUri, child: string): PanelSessionTestUri => ({
      scheme: 'file',
      fsPath: `${base.fsPath}/${child}`,
      toString: () => `${base.toString()}/${child}`
    })
  },
  commands: { executeCommand: overrides.executeCommand ?? (async () => undefined) },
  extensions: { all: [] },
  languages: { onDidChangeDiagnostics: () => panelSessionDisposable() },
  window: {
    tabGroups: { activeTabGroup: { activeTab: { input: { uri: document.uri } } } },
    showWarningMessage: overrides.showWarningMessage ?? (async () => undefined),
    onDidChangeTextEditorSelection: () => panelSessionDisposable(),
    onDidChangeActiveTextEditor: () => panelSessionDisposable(),
    onDidChangeVisibleTextEditors: () => panelSessionDisposable()
  },
  workspace: {
    textDocuments: [document],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
      inspect: () => undefined,
      update: async () => undefined
    }),
    onWillSaveTextDocument: overrides.onWillSaveTextDocument ?? (() => panelSessionDisposable()),
    onDidChangeTextDocument: overrides.onDidChangeTextDocument ?? (() => panelSessionDisposable()),
    onDidSaveTextDocument: overrides.onDidSaveTextDocument ?? (() => panelSessionDisposable()),
    createFileSystemWatcher: () => ({
      ...panelSessionDisposable(),
      onDidChange: () => panelSessionDisposable(),
      onDidCreate: () => panelSessionDisposable(),
      onDidDelete: () => panelSessionDisposable()
    }),
    applyEdit: overrides.applyEdit ?? (async () => true),
    fs: {}
  }
});

type ControllerParamsOptions = {
  readonly panel: unknown;
  readonly document: PanelSessionTestDocument;
  readonly pendingDraftRecovery: unknown;
  readonly readDiskText: () => string;
  readonly overrides?: Readonly<Record<string, unknown>>;
};

/** Common controller wiring; each scenario supplies only the platform behavior it exercises. */
export const createPanelSessionControllerParams = (
  options: ControllerParamsOptions
): Record<string, unknown> => ({
  panel: options.panel,
  document: options.document,
  documentUri: options.document.uri,
  context: {
    globalState: { get: <T>(_key: string, fallback?: T): T | undefined => fallback, update: async () => undefined }
  },
  diagnostics: { read: () => [] },
  agentReviewHandoff: { noteRecentMEOOwnedFileChangeForUri: () => undefined },
  pendingDraftRecovery: options.pendingDraftRecovery,
  gitBaselineRefreshTimer: { schedule: () => panelSessionCancelable() },
  savedRevisionFile: { read: async () => ({ ok: true as const, text: options.readDiskText() }) },
  savedRevisionRefreshTimer: { schedule: () => panelSessionCancelable() },
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
  saveDocument: async () => true,
  onExportDocument: async () => undefined,
  renderPreview: async () => ({ html: '', metadata: {} }),
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
  onPanelDisposed: () => undefined,
  ...options.overrides
});
