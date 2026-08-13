import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentReviewHandoffController } from '../agents/reviewHandoff';
import type { PendingDraftRecovery } from '../application/pendingDraftRecovery';
import {
  createGitBaselineRefreshCoordinator,
  type GitBaselineRefreshOptions,
  type GitBaselineRefreshTimer
} from '../application/gitBaselineRefreshCoordinator';
import {
  createSavedRevisionLifecycle,
  type SavedRevisionFileAdapter,
  type SavedRevisionRefreshTimer
} from '../application/savedRevisionLifecycle';
import {
  createDiffBaselineSelection,
  type DiffBaselineOutput
} from '../application/diffBaselineSelection';
import type { HostViewNavigationPort } from '../application/hostViewNavigationLifecycle';
import {
  EXTENSION_CONFIG_SECTION,
  LINE_NUMBERS_SETTING_KEY,
  GIT_CHANGES_GUTTER_SETTING_KEY,
  DIFF_BASELINE_MODE_SETTING_KEY,
  CONTENT_MAX_WIDTH_SETTING_KEY,
  LONG_CODE_BLOCKS_COLLAPSE_SETTING_KEY,
  OUTLINE_WIDTH_KEY,
  getContentMaxWidthEnabled,
  getLongCodeBlockFoldingEnabled,
  getLineNumbersEnabled,
  getGitChangesGutterEnabled,
  getGitDiffLineHighlightsEnabled,
  getDiffBaselineMode,
  getOutlinePosition,
  getOutlineVisible,
  getOutlineWidth,
  normalizeOutlineWidth,
  getThemeSettings,
  getVimKeybindings,
  getVimLeaderKey,
  getVimModeEnabled,
  getUseVscodeThemeForCodeBlocks,
  getCodeBlockVscodeTheme,
  type VimKeybinding
} from '../shared/extensionConfig';
import {
  openImageExternally,
  openLink,
  resolveLocalLinkTargets,
  resolveWebviewImageSrc,
  resolveWikiLinkTargets
} from '../shared/documentLinks';
import { resolveClipboardImageSaveRoot } from '../shared/clipboardImages';
import { GitDocumentState } from '../git/documentState';
import type { GitBaselinePayload } from '../git/types';
import { SavedRevisionTracker } from '../diff/savedRevisionTracker';
import type { ExportStyleEnvironment } from '../export/runtime';
import type { ThemeSettings } from '../shared/themeDefaults';
import type { PreviewAppearance, PreviewRenderResult } from '../shared/preview';
import type { EditorAppearance } from '../shared/editorAppearance';
import type { RawVscodeTheme } from '../shared/vscodeTheme';
import type { OutlinePosition } from '../shared/extensionConfig';
import type { InitMessage, SavedRevisionDto } from '../protocol/readyInit';
import type { AppliedMessage, ApplyChangesMessage, DiscardedChangesMessage, DocumentChangedMessage } from '../protocol/documentSync';
import type { ResolvedImageSrcResponse } from '../protocol/imageResolution';
import type { ResolvedWikiLinksResponse } from '../protocol/wikiLinkResolution';
import type { ResolvedLocalLinksResponse } from '../protocol/localLinkResolution';
import type { SaveImageFromClipboardRequest, SavedImagePathResponse } from '../protocol/clipboardImageSave';
import type { PreviewRenderResponse } from '../protocol/previewRender';
import { createExportSnapshotTransport } from '../host/exportSnapshotTransport';
import { respondToDocumentSessionRequest } from '../host/documentSessionRequestHandler';
import type { DocumentRevisionDto, DocumentRevisionResolution } from '../protocol/documentSession';
import type { HostEditorEvent } from '../protocol/hostEditorEvents';
import type { DiagnosticsChangedEvent, SerializedDiagnostic } from '../protocol/diagnostics';
import { decodeWebviewToHostMessage, type WebviewToHostMessage } from '../protocol/messages';
export type EditorMode = 'live' | 'source' | 'preview';
export type ExportFormat = 'html' | 'pdf';

const EDITOR_MODE_STATE_KEY = 'editorMode';

function isEditorMode(value: unknown): value is EditorMode {
  return value === 'live' || value === 'source' || value === 'preview';
}

type FindOptions = {
  wholeWord: boolean;
  caseSensitive: boolean;
};

const GIT_BASELINE_STARTUP_DELAY_MS = 350;
const GIT_BASELINE_REFRESH_DELAY_MS = 150;
type PanelDiagnostics = {
  read(): SerializedDiagnostic[];
};

type PanelSessionControllerParams = {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  documentUri: vscode.Uri;
  context: vscode.ExtensionContext;
  diagnostics: PanelDiagnostics;
  agentReviewHandoff: AgentReviewHandoffController;
  pendingDraftRecovery: PendingDraftRecovery;
  gitBaselineRefreshTimer: GitBaselineRefreshTimer;
  savedRevisionFile: SavedRevisionFileAdapter;
  savedRevisionRefreshTimer: SavedRevisionRefreshTimer;
  diffBaselineOutput: DiffBaselineOutput<GitBaselinePayload>;
  viewNavigation: HostViewNavigationPort<vscode.TextEditor>;
  saveDocument: () => Promise<boolean>;
  onExportDocument: (session: PanelSession, format: ExportFormat, appearance: PreviewAppearance) => Promise<void>;
  renderPreview: (options: {
    markdownText: string;
    sourceDocumentPath: string;
    styleEnvironment?: ExportStyleEnvironment;
  }) => Promise<PreviewRenderResult>;
  getFindOptions: () => FindOptions;
  setFindOptions: (options: FindOptions) => Promise<void>;
  getPreviewAppearance: () => PreviewAppearance;
  setPreviewAppearance: (appearance: PreviewAppearance) => Promise<void>;
  getEditorAppearance: () => EditorAppearance;
  setEditorAppearance: (appearance: EditorAppearance) => Promise<void>;
  setOutlineVisible: (visible: boolean) => Promise<void>;
  onPanelActivated: (panel: vscode.WebviewPanel) => void;
  onPanelViewStateChanged: () => void;
  onPanelDisposed: (panel: vscode.WebviewPanel) => void;
};

export type PanelSession = {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  documentUri: vscode.Uri;
  gitDocumentState: GitDocumentState;
  getMode: () => EditorMode;
  ensureInitDelivered: () => Promise<void>;
  requestExportSnapshot: () => Promise<{ text: string; environment?: ExportStyleEnvironment }>;
  refreshGitBaseline: (options?: GitBaselineRefreshOptions) => void;
  getGitRepoRoot: () => string | null;
};

export type PanelSessionController = {
  session: PanelSession;
  handleMessage: (raw: WebviewToHostMessage) => Promise<void>;
  dispose: () => void;
};

export function createPanelSessionController(params: PanelSessionControllerParams): PanelSessionController {
  const {
    panel,
    document,
    documentUri,
    context,
    diagnostics,
    agentReviewHandoff,
    pendingDraftRecovery,
    gitBaselineRefreshTimer,
    savedRevisionFile,
    savedRevisionRefreshTimer,
    diffBaselineOutput,
    viewNavigation,
    saveDocument,
    onExportDocument,
    renderPreview,
    getFindOptions,
    setFindOptions,
    getPreviewAppearance,
    setPreviewAppearance,
    getEditorAppearance,
    setEditorAppearance,
    setOutlineVisible,
    onPanelActivated,
    onPanelViewStateChanged,
    onPanelDisposed
  } = params;

  const documentKey = document.uri.toString();
  const persistedMode = context.globalState.get(EDITOR_MODE_STATE_KEY);
  let mode: EditorMode = isEditorMode(persistedMode) ? persistedMode : 'live';
  let applyQueue: Promise<void> = Promise.resolve();
  let webviewReady = false;
  let initDelivered = false;
  let disposed = false;
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const gitDocumentState = new GitDocumentState(documentUri.fsPath, workspaceRoot);
  const savedRevisionTracker = new SavedRevisionTracker();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    applyQueue = applyQueue.then(task, task);
    return applyQueue;
  };

  const reportBackgroundError = (contextLabel: string, error: unknown): void => {
    if (disposed) {
      return;
    }
    console.error(`[MEO panelSession] ${contextLabel}`, error);
  };

  const runBackground = (promise: PromiseLike<unknown>, contextLabel: string): void => {
    void Promise.resolve(promise).catch((error) => {
      reportBackgroundError(contextLabel, error);
    });
  };

  const postToWebview = async (message: Record<string, unknown>): Promise<boolean> => {
    if (disposed) {
      return false;
    }
    try {
      return await panel.webview.postMessage(message);
    } catch {
      return false;
    }
  };

  let notifySavedRevisionChanged = (): void => undefined;
  const savedRevisionLifecycle = createSavedRevisionLifecycle({
    file: savedRevisionFile,
    timer: savedRevisionRefreshTimer,
    readDocumentRevision: () => ({ version: document.version, text: document.getText() }),
    saveDocument,
    onRefresh: async ({ result, recoveredFromUnavailable }) => {
      if (!result.ok) {
        notifySavedRevisionChanged();
        return;
      }
      const changed = savedRevisionTracker.getCurrentEditBaseline()
        ? savedRevisionTracker.noteDiskRevision(result.text)
        : savedRevisionTracker.initialize(result.text);
      if (changed || recoveredFromUnavailable) {
        notifySavedRevisionChanged();
      }
    }
  });
  const refreshSavedRevisionNow = (): Promise<void> => savedRevisionLifecycle.refreshNow();
  const scheduleSavedRevisionRefresh = (delayMs?: number): void => {
    savedRevisionLifecycle.scheduleRefresh(delayMs);
  };
  let requestDiffBaselineRefresh = (_options: GitBaselineRefreshOptions): void => undefined;
  const diffBaselineSelection = createDiffBaselineSelection<GitBaselinePayload>({
    initialMode: getDiffBaselineMode(),
    readEnabled: () => getGitChangesGutterEnabled(context),
    canPublish: () => initDelivered,
    saved: {
      getPinned: () => savedRevisionTracker.getPinnedBaseline(),
      pinLatest: async () => {
        const existing = savedRevisionTracker.getPinnedBaseline();
        if (existing) return existing;
        await refreshSavedRevisionNow();
        return savedRevisionLifecycle.getUnavailableReason()
          ? null
          : savedRevisionTracker.pinLatestSavedBaseline();
      },
      releasePinned: () => savedRevisionTracker.releasePinnedBaseline(),
      resolve: async (baselineMode) => {
        if (!savedRevisionTracker.getCurrentEditBaseline()) await refreshSavedRevisionNow();
        const reason = savedRevisionLifecycle.getUnavailableReason();
        if (reason) return { ok: false, reason };
        const snapshot = savedRevisionTracker.getDiffBaseline(baselineMode);
        return snapshot
          ? { ok: true, text: snapshot.text }
          : { ok: false, reason: 'no-baseline' };
      }
    },
    git: {
      resolve: async (forceReload) => {
        const payload = await gitDocumentState.resolveBaseline({ includeText: true, force: forceReload });
        gitDocumentState.noteBaselinePayload(payload);
        return payload;
      }
    },
    output: diffBaselineOutput,
    persistMode: async (baselineMode) => {
      await vscode.workspace
        .getConfiguration(EXTENSION_CONFIG_SECTION)
        .update(DIFF_BASELINE_MODE_SETTING_KEY, baselineMode, vscode.ConfigurationTarget.Global);
    },
    warnNoSavedRevision: () => {
      void vscode.window.showWarningMessage('No saved version is available to pin as the Changes baseline.');
    },
    requestRefresh: (options) => requestDiffBaselineRefresh(options)
  });
  notifySavedRevisionChanged = () => diffBaselineSelection.savedRevisionChanged();

  const readInitialSavedRevision = async (): Promise<SavedRevisionDto | null> => {
    if (!savedRevisionTracker.getCurrentEditBaseline()) {
      const initial = await savedRevisionLifecycle.readInitial();
      if (initial === null) return null;
      savedRevisionTracker.initialize(initial.text);
      return initial;
    }
    const snapshot = savedRevisionTracker.getCurrentEditBaseline();
    if (snapshot === null) return null;
    return {
      version: snapshot.text === document.getText() ? document.version : null,
      text: snapshot.text
    };
  };

  const sendInit = async (): Promise<boolean> => {
    const savedRevision = await readInitialSavedRevision();
    const diffBaselineState = diffBaselineSelection.getState();
    const initialRestore = viewNavigation.getInitialRestore();
    const message: InitMessage = {
      type: 'init',
      documentId: documentKey,
      text: document.getText(),
      version: document.version,
      savedRevision,
      diagnostics: diagnostics.read(),
      mode,
      previewAppearance: getPreviewAppearance(),
      editorAppearance: getEditorAppearance(),
      lineNumbers: getLineNumbersEnabled(context),
      gitChangesGutter: getGitChangesGutterEnabled(context),
      gitDiffLineHighlights: getGitDiffLineHighlightsEnabled(),
      diffBaselineMode: diffBaselineState.mode,
      fixedBaselinePinned: diffBaselineState.fixedPinned,
      fixedBaselineActive: diffBaselineState.fixedActive,
      contentMaxWidthEnabled: getContentMaxWidthEnabled(context),
      longCodeBlockFoldingEnabled: getLongCodeBlockFoldingEnabled(),
      vimMode: getVimModeEnabled(context),
      vimKeybindings: getVimKeybindings(),
      vimLeader: getVimLeaderKey(),
      findOptions: getFindOptions(),
      outlinePosition: getOutlinePosition(),
      outlineVisible: getOutlineVisible(context),
      outlineWidth: getOutlineWidth(context),
      theme: getThemeSettings(),
      shikiCodeBlocks: getUseVscodeThemeForCodeBlocks(),
      codeTheme: getCodeBlockVscodeTheme(),
      restoreTopLine: initialRestore?.line,
      restoreTopLineOffset: initialRestore?.lineOffset
    };
    return postToWebview(message);
  };

  const sendDiagnosticsChanged = async (): Promise<boolean> => {
    const message: DiagnosticsChangedEvent = {
      type: 'diagnosticsChanged',
      diagnostics: diagnostics.read()
    };
    return postToWebview(message);
  };

  const sendDocChanged = async (): Promise<boolean> => {
    const message: DocumentChangedMessage = {
      type: 'docChanged',
      text: document.getText(),
      version: document.version
    };
    return postToWebview(message);
  };

  const sendApplied = async (version: number): Promise<boolean> => {
    const message: AppliedMessage = {
      type: 'applied',
      version
    };
    return postToWebview(message);
  };

  const readCurrentDocumentRevision = (): DocumentRevisionDto => ({
    version: document.version,
    text: document.getText().replace(/\r\n/g, '\n')
  });

  const saveExactDocumentRevision = async (
    expected: DocumentRevisionDto
  ): Promise<DocumentRevisionResolution> => {
    if (!savedRevisionTracker.getCurrentEditBaseline()) {
      await refreshSavedRevisionNow();
    }
    const current = readCurrentDocumentRevision();
    if (current.version !== expected.version || current.text !== expected.text) {
      return {
        ok: false,
        error: { code: 'operation-failed', message: 'Document Revision changed before save' }
      };
    }
    const previousDisk = savedRevisionTracker.getCurrentEditBaseline();
    const readBack = await savedRevisionLifecycle.saveAndReadBack(expected.text);
    if (!readBack.ok && readBack.reason === 'save-rejected') {
      return { ok: false, error: { code: 'operation-failed', message: 'VS Code rejected the document save' } };
    }
    if (!readBack.ok && readBack.reason === 'read-failed') {
      return { ok: false, error: { code: 'operation-failed', message: 'Saved document could not be read back' } };
    }
    if (!readBack.ok) {
      return { ok: false, error: { code: 'operation-failed', message: 'Saved text differs from the requested Revision' } };
    }
    const changed = savedRevisionTracker.getCurrentEditBaseline()
      ? savedRevisionTracker.noteExplicitSave(readBack.text, previousDisk)
      : savedRevisionTracker.initialize(readBack.text);
    if (changed) diffBaselineSelection.savedRevisionChanged();
    return { ok: true, value: { revision: expected } };
  };

  const ensureInitDelivered = async (): Promise<void> => {
    if (disposed || initDelivered || !webviewReady) {
      return;
    }
    const posted = await sendInit();
    if (posted) {
      initDelivered = true;
      await viewNavigation.ready();
    }
  };

  const requestExportSnapshot = async (): Promise<{ text: string; environment?: ExportStyleEnvironment }> => {
    await ensureInitDelivered();
    if (disposed) {
      throw new Error('The editor was closed before export completed.');
    }
    const result = await exportSnapshotTransport.request();
    if (result.ok === false) {
      throw new Error(result.error.message);
    }
    return result.value;
  };

  const gitBaselineRefresh = createGitBaselineRefreshCoordinator({
    timer: gitBaselineRefreshTimer,
    canRun: () => webviewReady,
    invalidateGitHead: () => gitDocumentState.invalidate(),
    prepare: async () => {
      await ensureInitDelivered();
      return initDelivered;
    },
    publish: async (options) => {
      await diffBaselineSelection.publish(options);
    }
  });
  requestDiffBaselineRefresh = (options) => gitBaselineRefresh.request(options);
  const refreshGitBaseline = (options: GitBaselineRefreshOptions = {}): void => {
    diffBaselineSelection.requestRefresh(options);
  };

  const exportSnapshotTransport = createExportSnapshotTransport(postToWebview);

  const postFocusEditor = async (): Promise<void> => {
    if (!webviewReady) {
      return;
    }
    await ensureInitDelivered();
    if (!initDelivered) {
      return;
    }
    const message: HostEditorEvent = { type: 'focusEditor' };
    await postToWebview(message);
  };

  const session: PanelSession = {
    panel,
    document,
    documentUri,
    gitDocumentState,
    getMode: () => mode,
    ensureInitDelivered,
    requestExportSnapshot,
    refreshGitBaseline,
    getGitRepoRoot: () => gitDocumentState.getRepoRoot()
  };

  const handleMessage = async (raw: WebviewToHostMessage): Promise<void> => {
    if (disposed) {
      return;
    }
    switch (raw.type) {
      case 'ready':
        webviewReady = true;
        await ensureInitDelivered();
        refreshGitBaseline({ forcePost: true, delayMs: GIT_BASELINE_STARTUP_DELAY_MS });
        return;
      case 'setMode':
        if (!isEditorMode(raw.mode)) {
          return;
        }
        mode = raw.mode;
        await context.globalState.update(EDITOR_MODE_STATE_KEY, mode);
        return;
      case 'setLineNumbers': {
        const visible = raw.visible ?? raw.enabled;
        if (typeof visible !== 'boolean') {
          return;
        }
        await vscode.workspace
          .getConfiguration(EXTENSION_CONFIG_SECTION)
          .update(LINE_NUMBERS_SETTING_KEY, visible, vscode.ConfigurationTarget.Global);
        return;
      }
      case 'setGitChangesGutter': {
        const visible = raw.visible ?? raw.enabled;
        if (typeof visible !== 'boolean') {
          return;
        }
        await vscode.workspace
          .getConfiguration(EXTENSION_CONFIG_SECTION)
          .update(GIT_CHANGES_GUTTER_SETTING_KEY, visible, vscode.ConfigurationTarget.Global);
        return;
      }
      case 'setDiffBaselineMode':
        await diffBaselineSelection.setMode(raw.mode);
        return;
      case 'setFixedBaseline':
        await enqueue(async () => {
          await diffBaselineSelection.setFixed(raw.enabled);
        });
        return;
      case 'releaseFixedBaseline':
        await enqueue(async () => {
          await diffBaselineSelection.releaseFixed();
        });
        return;
      case 'setOutlineVisible':
        await setOutlineVisible(raw.visible);
        return;
      case 'setOutlinePosition':
        await vscode.workspace
          .getConfiguration(EXTENSION_CONFIG_SECTION)
          .update('outline.position', raw.position === 'left' ? 'left' : 'right', vscode.ConfigurationTarget.Global);
        return;
      case 'setOutlineWidth':
        if (Number.isFinite(raw.width)) {
          await context.globalState.update(OUTLINE_WIDTH_KEY, normalizeOutlineWidth(raw.width));
        }
        return;
      case 'setContentMaxWidth':
        await vscode.workspace
          .getConfiguration(EXTENSION_CONFIG_SECTION)
          .update(CONTENT_MAX_WIDTH_SETTING_KEY, raw.enabled === true, vscode.ConfigurationTarget.Global);
        return;
      case 'setLongCodeBlockFolding':
        await vscode.workspace
          .getConfiguration(EXTENSION_CONFIG_SECTION)
          .update(LONG_CODE_BLOCKS_COLLAPSE_SETTING_KEY, raw.enabled === true, vscode.ConfigurationTarget.Global);
        return;
      case 'setFindOptions': {
        const wholeWord = raw.findOptions?.wholeWord ?? raw.wholeWord;
        const caseSensitive = raw.findOptions?.caseSensitive ?? raw.caseSensitive;
        await setFindOptions({
          wholeWord: wholeWord === true,
          caseSensitive: caseSensitive === true
        });
        return;
      }
      case 'viewPositionChanged':
        if (Number.isFinite(raw.topLine)) {
          await enqueue(async () => {
            await viewNavigation.rememberViewport(raw.topLine, raw.topLineOffset);
          });
        }
        return;
      case 'exportDocument':
        await onExportDocument(session, raw.format, raw.appearance);
        return;
      case 'setPreviewAppearance':
        await setPreviewAppearance(raw.appearance);
        return;
      case 'setEditorAppearance':
        await setEditorAppearance(raw.appearance);
        return;
      case 'openLink': {
        if (await viewNavigation.revealDocumentLink(raw.href)) return;
        await openLink(raw.href, documentUri, {
          localEditor: raw.source === 'preview' ? 'default' : 'associated'
        });
        return;
      }
      case 'openImageExternally':
        await openImageExternally(raw.url, documentUri);
        return;
      case 'resolveImageSrc': {
        let response: ResolvedImageSrcResponse;
        try {
          response = {
            type: 'resolvedImageSrc',
            requestId: raw.requestId,
            result: {
              ok: true,
              value: { resolvedUrl: await resolveWebviewImageSrc(raw.url, documentUri, panel.webview) }
            }
          };
        } catch (error) {
          response = {
            type: 'resolvedImageSrc',
            requestId: raw.requestId,
            result: {
              ok: false,
              error: {
                code: 'operation-failed',
                message: error instanceof Error ? error.message : 'Failed to resolve image source'
              }
            }
          };
        }
        await postToWebview(response);
        return;
      }
      case 'resolveWikiLinks': {
        let response: ResolvedWikiLinksResponse;
        try {
          response = {
            type: 'resolvedWikiLinks',
            requestId: raw.requestId,
            result: { ok: true, value: { results: await resolveWikiLinkTargets(raw.targets, documentUri) } }
          };
        } catch (error) {
          response = {
            type: 'resolvedWikiLinks',
            requestId: raw.requestId,
            result: {
              ok: false,
              error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Failed to resolve Wiki Links' }
            }
          };
        }
        await postToWebview(response);
        return;
      }
      case 'resolveLocalLinks': {
        let response: ResolvedLocalLinksResponse;
        try {
          response = {
            type: 'resolvedLocalLinks',
            requestId: raw.requestId,
            result: { ok: true, value: { results: await resolveLocalLinkTargets(raw.targets, documentUri) } }
          };
        } catch (error) {
          response = {
            type: 'resolvedLocalLinks',
            requestId: raw.requestId,
            result: {
              ok: false,
              error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Failed to resolve local links' }
            }
          };
        }
        await postToWebview(response);
        return;
      }
      case 'exportSnapshotResult':
        exportSnapshotTransport.accept(raw);
        return;
      case 'requestPreviewRender': {
        let response: PreviewRenderResponse;
        try {
          const rendered = await renderPreview({
            markdownText: raw.text,
            sourceDocumentPath: documentUri.fsPath,
            styleEnvironment: raw.environment
          });
          response = {
            type: 'previewRenderResult',
            requestId: raw.requestId,
            result: { ok: true, value: rendered }
          };
        } catch (error) {
          response = {
            type: 'previewRenderResult',
            requestId: raw.requestId,
            result: {
              ok: false,
              error: {
                code: 'operation-failed',
                message: error instanceof Error ? error.message : 'Failed to render Preview'
              }
            }
          };
        }
        await postToWebview(response);
        return;
      }
      case 'applyChanges':
        agentReviewHandoff.noteRecentMEOOwnedFileChangeForUri(document.uri);
        await enqueue(async () => {
          await applyDocumentChanges(document, raw, sendDocChanged, sendApplied);
        });
        return;
      case 'draftChanged':
        pendingDraftRecovery.remember(raw.text);
        return;
      case 'saveDocumentRevision':
      case 'requestDocumentRevision':
        await enqueue(async () => {
          const response = await respondToDocumentSessionRequest(raw, {
            readRevision: readCurrentDocumentRevision,
            saveRevision: saveExactDocumentRevision
          });
          await postToWebview(response);
        });
        return;
      case 'discardChanges':
        pendingDraftRecovery.remember(null);
        await enqueue(async () => {
          await vscode.commands.executeCommand('workbench.action.files.revert');
          await refreshSavedRevisionNow();
          const message: DiscardedChangesMessage = {
            type: 'discardedChanges',
            text: document.getText(),
            version: document.version,
            topLine: raw.topLine,
            topLineOffset: raw.topLineOffset ?? 0
          };
          await postToWebview(message);
        });
        return;
      case 'saveImageFromClipboard': {
        const response = await handleSaveImageFromClipboard(raw, documentUri);
        await postToWebview(response);
        return;
      }
    }
  };

  const messageSubscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
    const message = decodeWebviewToHostMessage(raw);
    if (!message) {
      return;
    }
    runBackground(
      handleMessage(message),
      'handleMessage'
    );
  });

  const documentChangeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() !== documentKey) {
      return;
    }

    // Save/dirty-state transitions can emit document events without text edits.
    if (event.contentChanges.length === 0) {
      return;
    }

    runBackground(enqueue(async () => {
      await sendDocChanged();
    }), 'sendDocChanged');
  });

  const documentSaveSubscription = vscode.workspace.onDidSaveTextDocument((savedDocument) => {
    if (savedDocument.uri.toString() !== documentKey) {
      return;
    }
    runBackground(enqueue(async () => {
      await sendDocChanged();
    }), 'sendDocChanged.save');
    refreshGitBaseline({ forceReload: true, delayMs: GIT_BASELINE_REFRESH_DELAY_MS });
    scheduleSavedRevisionRefresh(0);
  });

  const savedFileWatcher = documentUri.scheme === 'file'
    ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        path.dirname(documentUri.fsPath),
        path.basename(documentUri.fsPath)
      ))
    : null;
  const savedFileChangeSubscription = savedFileWatcher?.onDidChange(() => {
    scheduleSavedRevisionRefresh();
  });
  const savedFileCreateSubscription = savedFileWatcher?.onDidCreate(() => {
    scheduleSavedRevisionRefresh();
  });
  const savedFileDeleteSubscription = savedFileWatcher?.onDidDelete(() => {
    runBackground(savedRevisionLifecycle.markUnavailable('error'), 'markSavedRevisionUnavailable');
  });

  const diagnosticsSubscription = vscode.languages.onDidChangeDiagnostics((event) => {
    if (!event.uris.some((uri) => uri.toString() === documentKey)) {
      return;
    }
    runBackground(sendDiagnosticsChanged(), 'sendDiagnosticsChanged');
  });

  const textEditorSelectionSubscription = vscode.window.onDidChangeTextEditorSelection((event) => {
    runBackground(viewNavigation.revealSelectionForEditor(event.textEditor), 'viewNavigation.selection');
  });

  const activeTextEditorSubscription = vscode.window.onDidChangeActiveTextEditor((textEditor) => {
    runBackground(viewNavigation.revealSelectionForEditor(textEditor), 'viewNavigation.activeEditor');
  });

  const visibleTextEditorsSubscription = vscode.window.onDidChangeVisibleTextEditors(() => {
    runBackground(viewNavigation.revealCurrentEditorSelection(), 'viewNavigation.visibleEditors');
  });

  const viewStateSubscription = panel.onDidChangeViewState((event) => {
    if (event.webviewPanel.active) {
      onPanelActivated(event.webviewPanel);
      refreshGitBaseline({ forcePost: true, delayMs: GIT_BASELINE_REFRESH_DELAY_MS });
      runBackground(enqueue(async () => {
        await sendDocChanged();
      }), 'sendDocChanged.viewState');
      runBackground(viewNavigation.flush(), 'viewNavigation.flush');
      runBackground(viewNavigation.revealCurrentEditorSelection(), 'viewNavigation.viewState');
      runBackground(postFocusEditor(), 'postFocusEditor');
    }
    onPanelViewStateChanged();
  });

  const disposeSubscription = panel.onDidDispose(() => {
    dispose();
  });

  refreshGitBaseline({ forcePost: true, delayMs: GIT_BASELINE_STARTUP_DELAY_MS });
  scheduleSavedRevisionRefresh(0);
  runBackground(viewNavigation.revealCurrentEditorSelection(), 'viewNavigation.startup');

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    viewNavigation.dispose();
    diffBaselineSelection.dispose();
    gitBaselineRefresh.dispose();
    savedRevisionLifecycle.dispose();

    runBackground(enqueue(async () => {
      try {
        // Best-effort recovery for edits that never made it through the debounce/apply round-trip.
        await pendingDraftRecovery.recover();
      } catch {
        // Ignore dispose-time recovery failures to avoid surfacing noisy teardown errors.
      }
    }), 'disposeDraftRecovery');

    exportSnapshotTransport.close('The editor was closed before export completed.');
    messageSubscription.dispose();
    documentChangeSubscription.dispose();
    documentSaveSubscription.dispose();
    savedFileChangeSubscription?.dispose();
    savedFileCreateSubscription?.dispose();
    savedFileDeleteSubscription?.dispose();
    savedFileWatcher?.dispose();
    diagnosticsSubscription.dispose();
    textEditorSelectionSubscription.dispose();
    activeTextEditorSubscription.dispose();
    visibleTextEditorsSubscription.dispose();
    viewStateSubscription.dispose();
    disposeSubscription.dispose();
    onPanelDisposed(panel);
  };

  return {
    session,
    handleMessage,
    dispose
  };
}

async function applyDocumentChanges(
  document: vscode.TextDocument,
  message: ApplyChangesMessage,
  sendDocChanged: () => Promise<boolean>,
  sendApplied: (version: number) => Promise<boolean>
): Promise<void> {
  if (message.baseVersion !== document.version) {
    await sendDocChanged();
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const sortedChanges = [...message.changes].sort((a, b) => b.from - a.from);
  const documentText = document.getText();
  const mappedOffsetCache = new Map<number, number>();
  const mapOffset = (offset: number): number => {
    const cached = mappedOffsetCache.get(offset);
    if (typeof cached === 'number') {
      return cached;
    }
    const mapped = mapNormalizedOffsetToDocumentOffset(documentText, offset);
    mappedOffsetCache.set(offset, mapped);
    return mapped;
  };

  for (const change of sortedChanges) {
    // Webview offsets are LF-normalized; remap to real document offsets before applying edits.
    const mappedFrom = mapOffset(change.from);
    const mappedTo = mapOffset(change.to);
    const startOffset = Math.min(mappedFrom, mappedTo);
    const endOffset = Math.max(mappedFrom, mappedTo);
    const range = new vscode.Range(
      document.positionAt(startOffset),
      document.positionAt(endOffset)
    );
    edit.replace(document.uri, range, change.insert);
  }

  const applied = await vscode.workspace.applyEdit(edit);

  if (!applied) {
    await sendDocChanged();
    return;
  }

  await sendApplied(document.version);
}

function mapNormalizedOffsetToDocumentOffset(documentText: string, normalizedOffset: number): number {
  const target = Number.isFinite(normalizedOffset) ? Math.max(0, normalizedOffset) : documentText.length;
  if (target === 0) {
    return 0;
  }

  let normalizedIndex = 0;
  let documentIndex = 0;

  while (documentIndex < documentText.length && normalizedIndex < target) {
    if (documentText.charCodeAt(documentIndex) === 13) {
      if (documentText.charCodeAt(documentIndex + 1) === 10) {
        documentIndex += 2;
      } else {
        documentIndex += 1;
      }
      normalizedIndex += 1;
      continue;
    }

    documentIndex += 1;
    normalizedIndex += 1;
  }

  return documentIndex;
}

async function handleSaveImageFromClipboard(
  message: SaveImageFromClipboardRequest,
  documentUri: vscode.Uri
): Promise<SavedImagePathResponse> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  const saveRoot = workspaceFolder?.uri ?? vscode.Uri.file(resolveClipboardImageSaveRoot(documentUri.fsPath));
  const config = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
  const imageFolder = config.get<string>('imageFolder', 'assets');

  try {
    const base64Data = message.imageData.replace(/^data:image\/[^;]+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    const assetsFolderUri = vscode.Uri.joinPath(saveRoot, imageFolder);

    try {
      await vscode.workspace.fs.stat(assetsFolderUri);
    } catch {
      await vscode.workspace.fs.createDirectory(assetsFolderUri);
    }

    const filePath = vscode.Uri.joinPath(assetsFolderUri, message.fileName);
    await vscode.workspace.fs.writeFile(filePath, imageBuffer);

    const relativePath = path.relative(path.dirname(documentUri.fsPath), filePath.fsPath);

    return {
      type: 'savedImagePath',
      requestId: message.requestId,
      result: {
        ok: true,
        value: { path: relativePath.replace(/\\/g, '/') }
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to save image';
    return {
      type: 'savedImagePath',
      requestId: message.requestId,
      result: {
        ok: false,
        error: { code: 'operation-failed', message: errorMessage }
      }
    };
  }
}
