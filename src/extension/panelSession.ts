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
  createHostDiagnosticsLifecycle,
  type HostDiagnosticsRuntime,
  type HostDiagnosticsTimer
} from '../application/hostDiagnosticsLifecycle';
import {
  createDiffBaselineSelection,
  type DiffBaselineOutput
} from '../application/diffBaselineSelection';
import {
  EXTENSION_CONFIG_SECTION,
  LINE_NUMBERS_SETTING_KEY,
  GIT_CHANGES_GUTTER_SETTING_KEY,
  DIFF_BASELINE_MODE_SETTING_KEY,
  CONTENT_MAX_WIDTH_SETTING_KEY,
  LONG_CODE_BLOCKS_COLLAPSE_SETTING_KEY,
  SPELL_CHECK_SETTING_KEY,
  OUTLINE_WIDTH_KEY,
  getContentMaxWidthEnabled,
  getLongCodeBlockFoldingEnabled,
  getLineNumbersEnabled,
  getGitChangesGutterEnabled,
  getGitBlameEnabled,
  getGitDiffLineHighlightsEnabled,
  getDiffBaselineMode,
  getSpellCheckEnabled,
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
import { openGitRevisionForLine, openGitWorktreeForLine, resolveGitBlameForRequest } from '../git/blameActions';
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
import type { DiagnosticSuggestionsResult, RequestDiagnosticSuggestions } from '../protocol/diagnosticSuggestions';
import type { SaveImageFromClipboardRequest, SavedImagePathResponse } from '../protocol/clipboardImageSave';
import type { PreviewRenderResponse } from '../protocol/previewRender';
import { createExportSnapshotTransport } from '../host/exportSnapshotTransport';
import type { VscodeViewNavigationAdapter } from '../host/vscodeViewNavigationAdapter';
import { respondToDocumentSessionRequest } from '../host/documentSessionRequestHandler';
import type { DocumentRevisionDto, DocumentRevisionResolution } from '../protocol/documentSession';
import type { GitBlameResponse } from '../protocol/git';
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
const MAX_DIAGNOSTIC_SUGGESTIONS = 1;
type PanelSpellDiagnostics = HostDiagnosticsRuntime<vscode.Diagnostic> & {
  readCombined(): SerializedDiagnostic[];
  isInternalSource(source: string | undefined): boolean;
  collectSuggestions(from: number, to: number, enabled: boolean): Promise<string[]>;
};

type PanelSessionControllerParams = {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  documentUri: vscode.Uri;
  context: vscode.ExtensionContext;
  spellDiagnostics: PanelSpellDiagnostics;
  hostDiagnosticsTimer: HostDiagnosticsTimer;
  agentReviewHandoff: AgentReviewHandoffController;
  pendingDraftRecovery: PendingDraftRecovery;
  gitBaselineRefreshTimer: GitBaselineRefreshTimer;
  savedRevisionFile: SavedRevisionFileAdapter;
  savedRevisionRefreshTimer: SavedRevisionRefreshTimer;
  diffBaselineOutput: DiffBaselineOutput<GitBaselinePayload>;
  viewNavigation: VscodeViewNavigationAdapter;
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
  updateGitBlameEnabled: (enabled: boolean) => Promise<void>;
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
  refreshSpellDiagnostics: () => void;
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
    spellDiagnostics,
    hostDiagnosticsTimer,
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
    updateGitBlameEnabled,
    onPanelActivated,
    onPanelViewStateChanged,
    onPanelDisposed
  } = params;

  const documentKey = document.uri.toString();
  const persistedMode = context.globalState.get(EDITOR_MODE_STATE_KEY);
  let mode: EditorMode = isEditorMode(persistedMode) ? persistedMode : 'live';
  let gitBlameEnabled = getGitBlameEnabled();
  let spellCheckEnabled = getSpellCheckEnabled();
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
      diagnostics: spellDiagnostics.readCombined(),
      mode,
      previewAppearance: getPreviewAppearance(),
      editorAppearance: getEditorAppearance(),
      lineNumbers: getLineNumbersEnabled(context),
      gitChangesGutter: getGitChangesGutterEnabled(context),
      gitBlameEnabled,
      gitDiffLineHighlights: getGitDiffLineHighlightsEnabled(),
      diffBaselineMode: diffBaselineState.mode,
      fixedBaselinePinned: diffBaselineState.fixedPinned,
      fixedBaselineActive: diffBaselineState.fixedActive,
      spellCheckEnabled,
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
      diagnostics: spellDiagnostics.readCombined()
    };
    return postToWebview(message);
  };

  const hostDiagnosticsLifecycle = createHostDiagnosticsLifecycle({
    runtime: spellDiagnostics,
    timer: hostDiagnosticsTimer,
    readEnabled: () => spellCheckEnabled,
    publishCombined: async () => { await sendDiagnosticsChanged(); },
    reportFailure: (error) => reportBackgroundError('spellCheck', error)
  });

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
    refreshSpellDiagnostics: () => hostDiagnosticsLifecycle.requestRefresh(0),
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
        hostDiagnosticsLifecycle.requestRefresh(0);
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
      case 'setGitBlame':
        gitBlameEnabled = raw.enabled === true;
        await updateGitBlameEnabled(gitBlameEnabled);
        return;
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
      case 'setSpellCheck':
        spellCheckEnabled = raw.enabled === true;
        await vscode.workspace
          .getConfiguration(EXTENSION_CONFIG_SECTION)
          .update(SPELL_CHECK_SETTING_KEY, spellCheckEnabled, vscode.ConfigurationTarget.Global);
        hostDiagnosticsLifecycle.requestRefresh(0);
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
      case 'requestGitBlame': {
        if (!gitBlameEnabled) {
          const response: GitBlameResponse = {
            type: 'gitBlameResult',
            requestId: raw.requestId,
            lineNumber: raw.lineNumber,
            localEditGeneration: raw.localEditGeneration,
            result: { ok: true, value: { kind: 'unavailable', reason: 'error' } }
          };
          await postToWebview(response);
          return;
        }
        const resolved = await resolveGitBlameForRequest(documentUri, raw, document.getText(), gitDocumentState);
        const response: GitBlameResponse = {
          type: 'gitBlameResult',
          requestId: raw.requestId,
          lineNumber: raw.lineNumber,
          localEditGeneration: raw.localEditGeneration,
          result: { ok: true, value: resolved.result }
        };
        await postToWebview(response);
        return;
      }
      case 'openGitRevisionForLine':
        if (!gitBlameEnabled) {
          return;
        }
        await openGitRevisionForLine(documentUri, raw, document.getText(), gitDocumentState);
        return;
      case 'openGitWorktreeForLine':
        if (!gitBlameEnabled) {
          return;
        }
        await openGitWorktreeForLine(documentUri, raw, document.getText(), gitDocumentState);
        return;
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
      case 'requestDiagnosticSuggestions': {
        let response: DiagnosticSuggestionsResult;
        try {
          response = await resolveDiagnosticSuggestions(document, raw, spellCheckEnabled, spellDiagnostics);
        } catch (error) {
          response = {
            type: 'diagnosticSuggestionsResult',
            requestId: raw.requestId,
            from: raw.from,
            to: raw.to,
            result: {
              ok: false,
              error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Failed to resolve diagnostic suggestions' }
            }
          };
        }
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

    hostDiagnosticsLifecycle.requestRefresh();

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
    runBackground(hostDiagnosticsLifecycle.handleDiagnosticsChanged(), 'sendDiagnosticsChanged');
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
    hostDiagnosticsLifecycle.dispose();
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

function mapDocumentOffsetToNormalizedOffset(documentText: string, documentOffset: number): number {
  const target = Number.isFinite(documentOffset) ? Math.max(0, Math.min(documentOffset, documentText.length)) : 0;
  if (target === 0) {
    return 0;
  }

  let normalizedIndex = 0;
  let documentIndex = 0;

  while (documentIndex < target) {
    if (documentText.charCodeAt(documentIndex) === 13) {
      if (documentText.charCodeAt(documentIndex + 1) === 10 && documentIndex + 1 < target) {
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

  return normalizedIndex;
}

function normalizeDiagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  if (code && typeof code === 'object' && 'value' in code) {
    return String(code.value);
  }
  return undefined;
}

function clampDiagnosticRange(from: number, to: number, textLength: number): { from: number; to: number } | null {
  const clampedFrom = Math.max(0, Math.min(Math.floor(from), textLength));
  let clampedTo = Math.max(0, Math.min(Math.floor(to), textLength));
  if (clampedTo < clampedFrom) {
    clampedTo = clampedFrom;
  }
  if (clampedTo === clampedFrom && clampedFrom < textLength) {
    clampedTo = clampedFrom + 1;
  }
  if (clampedTo === clampedFrom && clampedFrom > 0) {
    return { from: clampedFrom - 1, to: clampedFrom };
  }
  if (clampedTo === clampedFrom) {
    return null;
  }
  return { from: clampedFrom, to: clampedTo };
}

async function resolveDiagnosticSuggestions(
  document: vscode.TextDocument,
  request: RequestDiagnosticSuggestions,
  spellCheckEnabled: boolean,
  spellDiagnostics: PanelSpellDiagnostics
): Promise<DiagnosticSuggestionsResult> {
  const emptyResponse: DiagnosticSuggestionsResult = {
    type: 'diagnosticSuggestionsResult',
    requestId: request.requestId,
    from: request.from,
    to: request.to,
    result: { ok: true, value: { suggestions: [] } }
  };

  const documentText = document.getText();
  const normalizedTextLength = documentText.replace(/\r\n?/g, '\n').length;
  const requestedRange = clampDiagnosticRange(request.from, request.to, normalizedTextLength);
  if (!requestedRange) {
    return emptyResponse;
  }

  const mappedFrom = mapNormalizedOffsetToDocumentOffset(documentText, requestedRange.from);
  const mappedTo = mapNormalizedOffsetToDocumentOffset(documentText, requestedRange.to);
  const range = new vscode.Range(
    document.positionAt(Math.min(mappedFrom, mappedTo)),
    document.positionAt(Math.max(mappedFrom, mappedTo))
  );

  if (!hasMatchingDiagnostic(document, request, requestedRange)) {
    return emptyResponse;
  }

  const actions = await vscode.commands.executeCommand<Array<vscode.Command | vscode.CodeAction>>(
    'vscode.executeCodeActionProvider',
    document.uri,
    range,
    vscode.CodeActionKind.QuickFix.value,
    64
  );
  const suggestions: string[] = [];
  const seen = new Set<string>();

  if (Array.isArray(actions)) {
    for (const action of actions) {
      const replacement = simpleReplacementFromCodeAction(document, requestedRange, action);
      if (replacement === null || seen.has(replacement)) {
        continue;
      }
      seen.add(replacement);
      suggestions.push(replacement);
      if (suggestions.length >= MAX_DIAGNOSTIC_SUGGESTIONS) {
        break;
      }
    }
  }

  if (suggestions.length === 0 && spellDiagnostics.isInternalSource(request.source)) {
    const spellSuggestions = await spellDiagnostics.collectSuggestions(
      requestedRange.from,
      requestedRange.to,
      spellCheckEnabled
    );
    for (const suggestion of spellSuggestions) {
      if (seen.has(suggestion)) {
        continue;
      }
      seen.add(suggestion);
      suggestions.push(suggestion);
      if (suggestions.length >= MAX_DIAGNOSTIC_SUGGESTIONS) {
        break;
      }
    }
  }

  return {
    ...emptyResponse,
    result: { ok: true, value: { suggestions } }
  };
}

function hasMatchingDiagnostic(
  document: vscode.TextDocument,
  request: RequestDiagnosticSuggestions,
  requestedRange: { from: number; to: number }
): boolean {
  const documentText = document.getText();
  return vscode.languages.getDiagnostics(document.uri).some((diagnostic) => {
    const from = mapDocumentOffsetToNormalizedOffset(documentText, document.offsetAt(diagnostic.range.start));
    const to = mapDocumentOffsetToNormalizedOffset(documentText, document.offsetAt(diagnostic.range.end));
    const range = clampDiagnosticRange(from, to, documentText.replace(/\r\n?/g, '\n').length);
    if (!range || range.from !== requestedRange.from || range.to !== requestedRange.to) {
      return false;
    }
    if (diagnostic.message !== request.message) {
      return false;
    }
    if ((diagnostic.source ?? undefined) !== (request.source ?? undefined)) {
      return false;
    }
    return (normalizeDiagnosticCode(diagnostic.code) ?? undefined) === (request.code ?? undefined);
  });
}

function simpleReplacementFromCodeAction(
  document: vscode.TextDocument,
  requestedRange: { from: number; to: number },
  action: vscode.Command | vscode.CodeAction
): string | null {
  if (!('edit' in action) || !action.edit || ('disabled' in action && action.disabled)) {
    return null;
  }

  const entries = action.edit.entries();
  if (entries.length !== 1) {
    return null;
  }

  const [uri, edits] = entries[0];
  if (uri.toString() !== document.uri.toString() || edits.length !== 1) {
    return null;
  }

  const [edit] = edits;
  const documentText = document.getText();
  const editFrom = mapDocumentOffsetToNormalizedOffset(documentText, document.offsetAt(edit.range.start));
  const editTo = mapDocumentOffsetToNormalizedOffset(documentText, document.offsetAt(edit.range.end));
  const editRange = clampDiagnosticRange(editFrom, editTo, documentText.replace(/\r\n?/g, '\n').length);
  if (!editRange || !rangesOverlap(editRange, requestedRange)) {
    return null;
  }

  return edit.newText;
}

function rangesOverlap(left: { from: number; to: number }, right: { from: number; to: number }): boolean {
  return left.from < right.to && right.from < left.to;
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
