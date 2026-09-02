import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { createGitApiWatcher } from './git/gitApiWatch';
import {
  AGENT_REVIEW_FILE_OVERRIDE_CLEANUP_DELAY_MS,
  AGENT_REVIEW_POST_REOPEN_DEDUP_DELAY_MS,
  AGENT_REVIEW_REOPEN_ON_CLOSE_DELAY_MS,
  AgentReviewHandoffController
} from './agents/reviewHandoff';
import {
  areAgentReviewTextsEquivalent,
  findLikelyAgentReviewState,
  getComparableFileUri,
  isLikelyAgentReviewUri,
  resolveAgentReviewRedirectState
} from './agents/reviewState';
import {
  getComparableResourceKey,
  getOpenTextDocumentForComparableKey,
  getOpenTextDocumentForUri,
  getPreferredCommandUri,
  parseGitUriQuery,
  resolveWorktreeUriFromGitUri
} from './agents/resourceMatching';
import { AgentReviewOverrideController } from './agents/reviewOverrides';
import {
  EXTENSION_CONFIG_SECTION,
  GIT_CHANGES_GUTTER_LEGACY_SETTING_KEY,
  GIT_CHANGES_GUTTER_LEGACY_VISIBLE_SETTING_KEY,
  GIT_CHANGES_GUTTER_LEGACY_VISIBILITY_SETTING_KEY,
  GIT_CHANGES_GUTTER_SETTING_KEY,
  OUTLINE_VISIBLE_KEY,
  getCurrentVscodeCodeTheme,
  syncEditorAssociations,
  getGitChangesGutterEnabled,
  getOutlineVisible,
  getContentMaxWidthEnabled,
  isMarkdownDocumentPath,
  migrateGitDiffLineHighlightsDefaultOff,
  migrateLegacyToggleSettings
} from './shared/extensionConfig';
import { createPanelSessionController, type ExportFormat, type PanelSession } from './extension/panelSession';
import { createVscodePendingDraftRecoveryAdapter } from './host/vscodePendingDraftRecoveryAdapter';
import { createGitBaselineRefreshTimerAdapter } from './host/gitBaselineRefreshTimerAdapter';
import { createVscodeSavedRevisionFileAdapter } from './host/vscodeSavedRevisionFileAdapter';
import { createSavedRevisionRefreshTimerAdapter } from './host/savedRevisionRefreshTimerAdapter';
import { createVscodeDiagnosticsAdapter } from './host/vscodeDiagnosticsAdapter';
import { createDiffBaselineProtocolAdapter } from './host/diffBaselineProtocolAdapter';
import { createVscodeViewNavigationAdapter } from './host/vscodeViewNavigationAdapter';
import { cleanupRetiredWorkspaceState } from './host/vscodeRetiredWorkspaceStateCleanup';
import { type PreviewRenderResult } from './shared/preview';
import {
  createAppearanceSettingsOwner,
  type AppearanceSettingsOwner,
  type AppearanceSettingsStore
} from './host/appearanceSettings';
import {
  collectWebviewImageResourceRoots,
  getDocumentFragmentHref,
  resolveLocalLinkTargetUri
} from './shared/documentLinks';
import {
  runWithTimedUiTimeout,
  showTimedErrorMessage,
  showTimedInformationMessage,
  showTimedWarningMessage,
} from './shared/timedUi';
import type { ExportStyleEnvironment } from './export/runtime';
import type { ReadingSnapshot } from './protocol/exportSnapshot';
import type { HostConfigurationEvent } from './protocol/hostConfigurationEvents';
import { resolveUiLanguage } from './foundation/uiLanguage';

const VIEW_TYPE = 'meoEnhanced.editor';
const ACTIVE_EDITOR_CONTEXT_KEY = 'meoEnhanced.activeEditor';
const FIND_OPTIONS_STATE_KEY = 'findOptions';

type FindOptionsState = {
  wholeWord: boolean;
  caseSensitive: boolean;
};

type ExportRuntimeModule = {
  renderExportHtmlDocument: (options: {
    readingSnapshot: ReadingSnapshot;
    sourceDocumentPath: string;
    outputFilePath: string;
    target: ExportFormat;
    mermaidRuntimeSrc: string;
    katexStylesHref: string;
    baseHref: string;
    title: string;
  }) => { htmlDocument: string; hasMermaid: boolean; hasMath: boolean };
  renderPreviewDocument: (options: {
    markdownText: string;
    sourceDocumentPath: string;
    uiLanguage: ReadingSnapshot['uiLanguage'];
    styleEnvironment?: ExportStyleEnvironment;
  }) => PreviewRenderResult;
  writeHtmlExport: (options: {
    htmlDocument: string;
    outputHtmlPath: string;
  }) => Promise<void>;
  renderPdfFromHtmlExport: (options: {
    htmlDocument: string;
    outputPdfPath: string;
    browserExecutablePath?: string;
    puppeteerRuntimeModulePath?: string;
    timeoutMs?: number;
  }) => Promise<void>;
};

let exportRuntimeModulePromise: Promise<ExportRuntimeModule> | null = null;

const hasExplicitConfigurationValue = (inspected: ReturnType<vscode.WorkspaceConfiguration['inspect']>): boolean => {
  if (!inspected) return false;
  const languageScoped = inspected as typeof inspected & {
    globalLanguageValue?: unknown;
    workspaceLanguageValue?: unknown;
    workspaceFolderLanguageValue?: unknown;
  };
  return inspected.globalValue !== undefined
    || inspected.workspaceValue !== undefined
    || inspected.workspaceFolderValue !== undefined
    || languageScoped.globalLanguageValue !== undefined
    || languageScoped.workspaceLanguageValue !== undefined
    || languageScoped.workspaceFolderLanguageValue !== undefined;
};

const createVscodeAppearanceSettingsStore = (context: vscode.ExtensionContext): AppearanceSettingsStore => ({
  readConfiguration: (key) => {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
    const inspected = configuration.inspect(key);
    return {
      value: configuration.get(key),
      explicit: hasExplicitConfigurationValue(inspected),
      globalValue: inspected?.globalValue
    };
  },
  updateConfiguration: (key, value) => Promise.resolve(vscode.workspace
    .getConfiguration(EXTENSION_CONFIG_SECTION)
    .update(key, value, vscode.ConfigurationTarget.Global)),
  readLegacy: (key) => context.globalState.get(key),
  updateLegacy: (key, value) => Promise.resolve(context.globalState.update(key, value))
});

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await migrateGitDiffLineHighlightsDefaultOff(context);
  const appearanceSettings = await createAppearanceSettingsOwner(createVscodeAppearanceSettingsStore(context));
  void vscode.commands.executeCommand('setContext', ACTIVE_EDITOR_CONTEXT_KEY, false);
  const useAsDefault = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION).get<boolean>('useAsDefault', true);
  void syncEditorAssociations(useAsDefault);

  const agentReviewHandoff = new AgentReviewHandoffController({
    viewType: VIEW_TYPE,
    getComparableResourceKey,
    getOpenTextDocumentForUri,
    hasLikelyReviewState: (targetUri, targetText) =>
      Boolean(findLikelyAgentReviewState(targetUri, getComparableResourceKey, getOpenTextDocumentForUri, targetText))
  });
  const agentReviewOverrides = new AgentReviewOverrideController(context, {
    getComparableResourceKey,
    getOpenTextDocumentForComparableKey,
    isLikelyAgentReviewUri
  });
  void agentReviewOverrides.syncNow();

  const provider = new MarkdownWebviewProvider(context, agentReviewHandoff, appearanceSettings);
  void provider.initializeGitWatcher();

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.useAsDefault`)) {
        const shouldUseAsDefault = vscode.workspace
          .getConfiguration(EXTENSION_CONFIG_SECTION)
          .get<boolean>('useAsDefault', true);
        void syncEditorAssociations(shouldUseAsDefault);
      }

      if (event.affectsConfiguration('workbench.colorTheme')) {
        provider.notifyVscodeCodeThemeChanged();
      }

      void provider.handleConfigurationChanged(event);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      provider.notifyVscodeCodeThemeChanged(theme.kind);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!isLikelyAgentReviewUri(document.uri)) {
        return;
      }
      void agentReviewOverrides.syncNow();
      void provider.redirectOpenEditorsForCopilotReview(document.uri);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!isLikelyAgentReviewUri(document.uri)) {
        return;
      }
      agentReviewOverrides.scheduleSync(AGENT_REVIEW_FILE_OVERRIDE_CLEANUP_DELAY_MS);
      const targetUri = getComparableFileUri(document.uri, getComparableResourceKey);
      if (targetUri) {
        const targetPath = (targetUri.path || targetUri.fsPath || '').toLowerCase();
        if (isMarkdownDocumentPath(targetPath)) {
          const openTargetDocument = getOpenTextDocumentForUri(targetUri);
          const reviewApplied = areAgentReviewTextsEquivalent(document.getText(), openTargetDocument?.getText());
          if (reviewApplied && agentReviewHandoff.hasOpenNativeTextTabForUri(targetUri)) {
            agentReviewHandoff.scheduleDeferredReopen(targetUri);
          }
        }

        agentReviewHandoff.notePendingMEOtabDedup(targetUri);
        agentReviewHandoff.scheduleMEOtabDedup(targetUri, AGENT_REVIEW_POST_REOPEN_DEDUP_DELAY_MS);
      }
      agentReviewHandoff.scheduleFlushDeferredReopens(AGENT_REVIEW_REOPEN_ON_CLOSE_DELAY_MS);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const isAgentReviewDocument = isLikelyAgentReviewUri(event.document.uri);
      if (isAgentReviewDocument) {
        agentReviewOverrides.scheduleSync();
      }
      if (!agentReviewHandoff.hasRecentMEOOwnedFileChangeForUri(event.document.uri)) {
        void provider.redirectOpenEditorsForCopilotReview(event.document.uri);
      }

      const shouldReevaluate = agentReviewHandoff.shouldReevaluateDeferredReopen(
        event.document.uri,
        isAgentReviewDocument
      );
      if (!shouldReevaluate) {
        return;
      }

      if (!isAgentReviewDocument) {
        agentReviewOverrides.scheduleSync();
      }
      agentReviewHandoff.scheduleFlushDeferredReopens();
    })
  );

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      agentReviewHandoff.noteRecentTextDiffActivity(event.opened);
      agentReviewHandoff.noteRecentTextDiffActivity(event.changed);
      void agentReviewHandoff.flushPendingMEOtabDedups();
      if (!agentReviewHandoff.hasPendingDeferredReopens()) {
        return;
      }
      agentReviewHandoff.scheduleFlushDeferredReopens();
    })
  );

  void migrateLegacyToggleSettings(context);
  void cleanupRetiredWorkspaceState(context.workspaceState);

  context.subscriptions.push(
    vscode.commands.registerCommand('meoEnhanced.open', async (uriLike?: unknown) => {
      const targetUri = getPreferredCommandUri(uriLike);
      if (!targetUri) {
        return;
      }
      const targetPath = (targetUri.path || targetUri.fsPath || '').toLowerCase();
      if (!isMarkdownDocumentPath(targetPath)) {
        return;
      }
      const pendingReview = findLikelyAgentReviewState(
        targetUri,
        getComparableResourceKey,
        getOpenTextDocumentForUri,
        getOpenTextDocumentForUri(targetUri)?.getText()
      );
      if (pendingReview) {
        agentReviewHandoff.scheduleDeferredReopen(targetUri);
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', targetUri, VIEW_TYPE);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('meoEnhanced.toggleEditor', async (uriLike?: unknown) => {
      const targetUri = getPreferredCommandUri(uriLike);
      if (!targetUri || !isMarkdownDocumentPath((targetUri.path || targetUri.fsPath || '').toLowerCase())) {
        return;
      }

      const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const targetViewType = activeTabInput instanceof vscode.TabInputCustom && activeTabInput.viewType === VIEW_TYPE
        ? 'default'
        : VIEW_TYPE;
      await vscode.commands.executeCommand('vscode.openWith', targetUri, targetViewType);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('meoEnhanced.setDefaultEditor', async () => {
      await syncEditorAssociations(true);
      void showTimedInformationMessage('MEO Enhanced is now set as the default editor for Markdown files.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('meoEnhanced.toggleMode', async () => {
      await provider.toggleActiveEditorMode();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('meoEnhanced.exportHtml', async () => {
      await provider.exportActiveDocument('html');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('meoEnhanced.exportPdf', async () => {
      await provider.exportActiveDocument('pdf');
    })
  );
}

class MarkdownWebviewProvider implements vscode.CustomTextEditorProvider {
  private readonly activePanels = new Set<vscode.WebviewPanel>();
  private readonly panelSessions = new Map<vscode.WebviewPanel, PanelSession>();
  private lastActivePanel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agentReviewHandoff: AgentReviewHandoffController,
    private readonly appearanceSettings: AppearanceSettingsOwner
  ) {}

  async initializeGitWatcher(): Promise<void> {
    const watcher = await createGitApiWatcher((repoRootFsPath) => {
      for (const session of this.panelSessions.values()) {
        if (session.getGitRepoRoot() !== repoRootFsPath) {
          continue;
        }
        session.refreshGitBaseline({ forceReload: true });
      }
    });
    if (watcher) {
      this.context.subscriptions.push(watcher);
    }
  }

  async exportActiveDocument(format: ExportFormat): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      void showTimedWarningMessage('Open a Markdown file in MEO Enhanced before exporting.');
      return;
    }

    await this.exportSessionDocument(session, format);
  }

  async redirectOpenEditorsForCopilotReview(triggerUri: vscode.Uri): Promise<void> {
    const reviewState = resolveAgentReviewRedirectState(
      triggerUri,
      getComparableResourceKey,
      getOpenTextDocumentForUri
    );
    if (!reviewState) {
      return;
    }

    const reviewKey = getComparableResourceKey(reviewState.uri);
    if (!reviewKey) {
      return;
    }

    for (const session of Array.from(this.panelSessions.values())) {
      if (getComparableResourceKey(session.documentUri) !== reviewKey) {
        continue;
      }

      if (this.agentReviewHandoff.hasRecentTextDiffActivityForUri(session.documentUri)) {
        continue;
      }

      if (this.agentReviewHandoff.hasOpenTextDiffTabForUri(session.documentUri)) {
        continue;
      }

      if (areAgentReviewTextsEquivalent(reviewState.text, session.document.getText())) {
        continue;
      }

      this.agentReviewHandoff.scheduleDeferredReopen(session.documentUri);
      await this.redirectCopilotReviewToNativeEditor(session.document, session.panel);
    }
  }

  async handleConfigurationChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
    if (
      event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${GIT_CHANGES_GUTTER_SETTING_KEY}`) ||
      event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${GIT_CHANGES_GUTTER_LEGACY_VISIBLE_SETTING_KEY}`) ||
      event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${GIT_CHANGES_GUTTER_LEGACY_VISIBILITY_SETTING_KEY}`) ||
      event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${GIT_CHANGES_GUTTER_LEGACY_SETTING_KEY}`)
    ) {
      const enabled = getGitChangesGutterEnabled(this.context);
      for (const session of this.panelSessions.values()) {
        session.refreshGitBaseline({ forcePost: true, forceReload: true, delayMs: enabled ? 150 : 0 });
      }
    }

  }

  notifyVscodeCodeThemeChanged(kind: vscode.ColorThemeKind = vscode.window.activeColorTheme.kind): void {
    const appearance = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';
    this.broadcast({
      type: 'vscodeCodeThemeChanged',
      appearance,
      vscodeTheme: getCurrentVscodeCodeTheme(kind)
    });
  }

  async toggleActiveEditorMode(): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      return;
    }

    this.lastActivePanel = session.panel;
    await session.ensureInitDelivered();
    const message: HostConfigurationEvent = { type: 'toggleMode' };
    await session.panel.webview.postMessage(message);
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const pendingReview = findLikelyAgentReviewState(
      document.uri,
      getComparableResourceKey,
      getOpenTextDocumentForUri,
      document.getText()
    );
    if (pendingReview) {
      this.agentReviewHandoff.scheduleDeferredReopen(document.uri);
      await this.redirectCopilotReviewToNativeEditor(document, panel, true);
      return;
    }

    if (await this.redirectGitResourceToNativeEditor(document, panel)) {
      return;
    }

    this.activePanels.add(panel);

    const documentUri = resolveWorktreeUri(document);
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: collectLocalResourceRoots(distRoot, documentUri, document.getText())
    };

    const controller = createPanelSessionController({
      panel,
      document,
      documentUri,
      context: this.context,
      diagnostics: createVscodeDiagnosticsAdapter(document),
      agentReviewHandoff: this.agentReviewHandoff,
      pendingDraftRecovery: createVscodePendingDraftRecoveryAdapter({
        document,
        noteOwnedFileChange: (uri) => this.agentReviewHandoff.noteRecentMEOOwnedFileChangeForUri(uri)
      }),
      gitBaselineRefreshTimer: createGitBaselineRefreshTimerAdapter(),
      savedRevisionFile: createVscodeSavedRevisionFileAdapter(documentUri),
      savedRevisionRefreshTimer: createSavedRevisionRefreshTimerAdapter(),
      diffBaselineOutput: createDiffBaselineProtocolAdapter({
        readDocumentVersion: () => document.version,
        post: async (message) => {
          try {
            return await panel.webview.postMessage(message);
          } catch {
            return false;
          }
        }
      }),
      viewNavigation: createVscodeViewNavigationAdapter({
        document,
        documentUri,
        getDocumentFragmentHref,
        resolveLocalLinkTarget: resolveLocalLinkTargetUri,
        post: async (message) => {
          try {
            return await panel.webview.postMessage(message);
          } catch {
            return false;
          }
        }
      }),
      saveDocument: async () => document.save(),
      onExportDocument: (session, format) => this.exportSessionDocument(session, format),
      renderPreview: async (options) => {
        const exportRuntime = await loadExportRuntimeModule(this.context.extensionUri);
        return exportRuntime.renderPreviewDocument({
          ...options
        });
      },
      getFindOptions: () => this.getFindOptions(),
      getUiLanguage: () => resolveUiLanguage(
        vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION).get('language', 'auto'),
        vscode.env.language
      ),
      getSourceLineNumbers: () => {
        const value = vscode.workspace
          .getConfiguration('editor', documentUri)
          .get<string>('lineNumbers', 'on');
        return value === 'off' || value === 'relative' || value === 'interval' ? value : 'on';
      },
      setFindOptions: (options) => this.setFindOptions(options),
      getPreviewAppearance: this.appearanceSettings.getPreviewAppearance,
      setPreviewAppearance: this.appearanceSettings.setPreviewAppearance,
      getPreviewFontFamily: this.appearanceSettings.getPreviewFontFamily,
      setPreviewFontFamily: this.appearanceSettings.setPreviewFontFamily,
      getPreviewSourceColoring: this.appearanceSettings.getPreviewSourceColoring,
      setPreviewSourceColoring: this.appearanceSettings.setPreviewSourceColoring,
      getEditorAppearance: this.appearanceSettings.getEditorAppearance,
      setEditorAppearance: this.appearanceSettings.setEditorAppearance,
      getEditorFontSizePreference: this.appearanceSettings.getEditorFontSizePreference,
      setEditorFontSizePreference: this.appearanceSettings.setEditorFontSizePreference,
      setOutlineVisible: (visible) => this.setOutlineVisible(visible),
      onPanelActivated: (activePanel) => {
        this.lastActivePanel = activePanel;
      },
      onPanelViewStateChanged: () => {
        this.updateActiveEditorContext();
      },
      onPanelDisposed: (disposedPanel) => {
        this.activePanels.delete(disposedPanel);
        this.panelSessions.delete(disposedPanel);
        if (this.lastActivePanel === disposedPanel) {
          this.lastActivePanel = null;
        }
        this.updateActiveEditorContext();
      }
    });

    panel.webview.html = this.getWebviewHtml(panel.webview);
    this.panelSessions.set(panel, controller.session);
    if (panel.active) {
      this.lastActivePanel = panel;
    }
    this.updateActiveEditorContext();
  }

  private broadcast(message: HostConfigurationEvent): void {
    for (const panel of this.activePanels) {
      void panel.webview.postMessage(message);
    }
  }

  private getFindOptions(): FindOptionsState {
    const stored = this.context.globalState.get<Partial<FindOptionsState> | undefined>(FIND_OPTIONS_STATE_KEY);
    return {
      wholeWord: stored?.wholeWord === true,
      caseSensitive: stored?.caseSensitive === true
    };
  }

  private async setFindOptions(options: FindOptionsState): Promise<void> {
    const nextOptions: FindOptionsState = {
      wholeWord: options.wholeWord === true,
      caseSensitive: options.caseSensitive === true
    };
    const currentOptions = this.getFindOptions();
    if (
      currentOptions.wholeWord === nextOptions.wholeWord &&
      currentOptions.caseSensitive === nextOptions.caseSensitive
    ) {
      return;
    }

    await this.context.globalState.update(FIND_OPTIONS_STATE_KEY, nextOptions);
  }

  private async setOutlineVisible(visible: boolean): Promise<void> {
    const nextVisible = visible === true;
    if (getOutlineVisible(this.context) === nextVisible) {
      return;
    }

    await this.context.globalState.update(OUTLINE_VISIBLE_KEY, nextVisible);
  }

  private updateActiveEditorContext(): void {
    const hasActiveMEOEditor = Array.from(this.panelSessions.keys()).some((panel) => panel.active);
    void vscode.commands.executeCommand('setContext', ACTIVE_EDITOR_CONTEXT_KEY, hasActiveMEOEditor);
  }

  private getActiveSession(): PanelSession | null {
    if (this.lastActivePanel && this.panelSessions.has(this.lastActivePanel)) {
      return this.panelSessions.get(this.lastActivePanel) ?? null;
    }

    for (const panel of this.activePanels) {
      if (panel.active && this.panelSessions.has(panel)) {
        this.lastActivePanel = panel;
        return this.panelSessions.get(panel) ?? null;
      }
    }

    const first = this.panelSessions.values().next();
    return first.done ? null : first.value;
  }

  private async exportSessionDocument(
    session: PanelSession,
    format: ExportFormat
  ): Promise<void> {
    this.lastActivePanel = session.panel;

    if (session.documentUri.scheme !== 'file') {
      void showTimedWarningMessage('Export is only supported for local Markdown files in the current version.');
      return;
    }

    const saveUri = await this.promptExportTargetUri(session.documentUri, format);
    if (!saveUri) {
      return;
    }

    try {
      await runWithTimedUiTimeout(() =>
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
            title: format === 'html' ? 'Exporting Markdown to HTML' : 'Exporting Markdown to PDF'
          },
          async (progress) => {
            progress.report({ message: 'Collecting editor content…' });
            const snapshot = await session.requestExportSnapshot();

            progress.report({ message: 'Rendering export document…' });
            const exportRuntime = await loadExportRuntimeModule(this.context.extensionUri);
            const exportRender = await this.buildExportHtmlDocument(exportRuntime, {
              readingSnapshot: snapshot,
              sourceDocumentUri: session.documentUri,
              outputFileUri: saveUri,
              target: format
            });

            if (format === 'html') {
              progress.report({ message: 'Writing HTML…' });
              await exportRuntime.writeHtmlExport({
                htmlDocument: exportRender.htmlDocument,
                outputHtmlPath: saveUri.fsPath
              });
              return;
            }

            progress.report({ message: 'Rendering PDF in headless browser…' });
            const puppeteerRuntimeModulePath = vscode.Uri.joinPath(
              this.context.extensionUri,
              'dist',
              'puppeteer-runtime.js'
            ).fsPath;
            await exportRuntime.renderPdfFromHtmlExport({
              htmlDocument: exportRender.htmlDocument,
              outputPdfPath: saveUri.fsPath,
              puppeteerRuntimeModulePath
            });
          }
        )
      );

      void vscode.window.setStatusBarMessage(
        `${format.toUpperCase()} export completed: ${saveUri.fsPath}`,
        5000
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed';
      void showTimedErrorMessage(`${format.toUpperCase()} export failed: ${message}`);
    }
  }

  private async promptExportTargetUri(documentUri: vscode.Uri, format: ExportFormat): Promise<vscode.Uri | undefined> {
    const defaultUri = vscode.Uri.file(replaceFileExtension(documentUri.fsPath, format === 'html' ? '.html' : '.pdf'));
    return vscode.window.showSaveDialog({
      defaultUri,
      filters: format === 'html'
        ? { HTML: ['html', 'htm'] }
        : { PDF: ['pdf'] },
      saveLabel: format === 'html' ? 'Export HTML' : 'Export PDF'
    });
  }

  private async buildExportHtmlDocument(
    exportRuntime: ExportRuntimeModule,
    params: {
      readingSnapshot: ReadingSnapshot;
      sourceDocumentUri: vscode.Uri;
      outputFileUri: vscode.Uri;
      target: ExportFormat;
    }
  ): Promise<{ htmlDocument: string; hasMermaid: boolean; hasMath: boolean }> {
    const mermaidRuntimeSrc = pathToFileURL(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist', 'mermaid.min.js').fsPath
    ).toString();
    const katexStylesHref = pathToFileURL(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist', 'katex', 'katex.min.css').fsPath
    ).toString();
    const baseHref = pathToFileURL(`${path.dirname(params.outputFileUri.fsPath)}${path.sep}`).toString();
    return exportRuntime.renderExportHtmlDocument({
      readingSnapshot: params.readingSnapshot,
      sourceDocumentPath: params.sourceDocumentUri.fsPath,
      outputFilePath: params.outputFileUri.fsPath,
      target: params.target,
      mermaidRuntimeSrc,
      katexStylesHref,
      baseHref,
      title: path.basename(params.outputFileUri.fsPath)
    });
  }

  private async redirectGitResourceToNativeEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): Promise<boolean> {
    if (document.uri.scheme !== 'git') {
      return false;
    }

    const viewColumn = panel.viewColumn ?? vscode.ViewColumn.Active;
    const editorOptions = {
      preserveFocus: false,
      preview: true,
      override: 'default'
    };
    const existingDiff = findDiffContextForGitUri(document.uri);

    if (existingDiff) {
      await vscode.commands.executeCommand(
        '_workbench.diff',
        existingDiff.original,
        existingDiff.modified,
        existingDiff.title,
        [viewColumn, editorOptions]
      );
      panel.dispose();
      return true;
    }

    const ref = getGitUriRef(document.uri);
    if (isWorkingTreeOrIndexRef(ref)) {
      const targetUri = resolveWorktreeUri(document);
      const title = getNativeWorkingTreeTitle(document.uri, targetUri);

      await vscode.commands.executeCommand(
        '_workbench.diff',
        document.uri,
        targetUri,
        title,
        [viewColumn, editorOptions]
      );
      panel.dispose();
      return true;
    }

    return false;
  }

  private async redirectCopilotReviewToNativeEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    preserveFocus = false
  ): Promise<void> {
    const viewColumn = panel.viewColumn ?? vscode.ViewColumn.Active;
    await vscode.commands.executeCommand(
      'vscode.openWith',
      document.uri,
      'default',
      {
        viewColumn,
        preserveFocus,
        preview: true
      }
    );
    panel.dispose();
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist', 'index.js'))
      .toString();
    const styleUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist', 'index.css'))
      .toString();
    const katexStyleUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist', 'katex', 'katex-embedded.css'))
      .toString();
    const mermaidRuntimeUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist', 'mermaid.min.js'))
      .toString();
    const nonce = getNonce();
    const initialHtmlClass = getContentMaxWidthEnabled(this.context)
      ? ' class="meo-content-max-width-enabled"'
      : '';
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`
    ].join('; ');

    return `<!DOCTYPE html>
    <html lang="en"${initialHtmlClass}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="Content-Security-Policy" content="${csp};" />
        <title>MEO Enhanced</title>
        <style>${getWebviewPreloadShellCss()}</style>
        <link href="${katexStyleUri}" rel="stylesheet" />
        <link href="${styleUri}" rel="stylesheet" />
      </head>
      <body data-meo-katex-src="${katexStyleUri}">
        <div id="app" class="editor-root">
          ${getWebviewPreloadShellMarkup()}
        </div>
        <script nonce="${nonce}" src="${mermaidRuntimeUri}"></script>
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
    </html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return nonce;
}

function getWebviewPreloadShellCss(): string {
  return `
      html, body {
        margin: 0;
        padding: 0;
        height: 100%;
      }
      body {
        background: var(--meo-background, var(--vscode-editor-background));
      }
      #app {
        min-height: 100%;
        display: flex;
        flex-direction: column;
      }
      #app > .mode-toolbar.meo-preload-toolbar {
        min-height: 40px;
        box-sizing: border-box;
        background: var(--vscode-sideBar-background);
      }
      #app > .editor-wrapper.meo-preload-editor-shell {
        flex: 1;
        min-height: 0;
        display: flex;
      }
      #app > .editor-wrapper.meo-preload-editor-shell > .editor-host {
        flex: 1;
        min-width: 0;
        min-height: 0;
        background: var(--meo-background, var(--vscode-editor-background));
      }
    `;
}

function getWebviewPreloadShellMarkup(): string {
  return `
          <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
          <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
            <div class="editor-host"></div>
          </div>
        `;
}

async function loadExportRuntimeModule(extensionUri: vscode.Uri): Promise<ExportRuntimeModule> {
  if (!exportRuntimeModulePromise) {
    const runtimePath = vscode.Uri.joinPath(extensionUri, 'dist', 'export-runtime.js').fsPath;
    const runtimeUrl = pathToFileURL(runtimePath).toString();
    exportRuntimeModulePromise = import(runtimeUrl)
      .then((mod: unknown) => unwrapExportRuntimeModule(mod))
      .catch((error) => {
        exportRuntimeModulePromise = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load export runtime (${runtimePath}). Run the extension build to regenerate it. ${message}`);
      });
  }

  return exportRuntimeModulePromise;
}

function unwrapExportRuntimeModule(mod: unknown): ExportRuntimeModule {
  let current: unknown = mod;
  for (let i = 0; i < 5; i += 1) {
    const candidate = current as Partial<ExportRuntimeModule> | undefined;
    if (
      candidate &&
      typeof candidate.renderExportHtmlDocument === 'function' &&
      typeof candidate.renderPreviewDocument === 'function' &&
      typeof candidate.writeHtmlExport === 'function' &&
      typeof candidate.renderPdfFromHtmlExport === 'function'
    ) {
      return candidate as ExportRuntimeModule;
    }

    if (!current || typeof current !== 'object' || !('default' in current)) {
      break;
    }
    current = (current as { default?: unknown }).default;
  }

  throw new Error('Loaded export runtime does not expose the expected export functions.');
}

function collectLocalResourceRoots(distRoot: vscode.Uri, documentUri: vscode.Uri, documentText: string): vscode.Uri[] {
  const roots = new Map<string, vscode.Uri>();
  roots.set(distRoot.toString(), distRoot);

  const documentDir = vscode.Uri.file(path.dirname(documentUri.fsPath));
  roots.set(documentDir.toString(), documentDir);

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.set(folder.uri.toString(), folder.uri);
  }

  for (const imageUri of collectWebviewImageResourceRoots(documentText, documentUri)) {
    roots.set(imageUri.toString(), imageUri);
  }

  return Array.from(roots.values());
}

function replaceFileExtension(filePath: string, ext: '.html' | '.pdf'): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${ext}`);
}

function resolveWorktreeUri(document: vscode.TextDocument): vscode.Uri {
  if (document.uri.scheme === 'file') {
    return document.uri;
  }

  return resolveWorktreeUriFromGitUri(document.uri) ?? document.uri;
}

function findDiffContextForGitUri(uri: vscode.Uri): { original: vscode.Uri; modified: vscode.Uri; title: string } | undefined {
  const target = uri.toString();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputTextDiff)) {
        continue;
      }

      const original = input.original;
      const modified = input.modified;
      if (original.toString() !== target && modified.toString() !== target) {
        continue;
      }

      return {
        original,
        modified,
        title: tab.label
      };
    }
  }

  return undefined;
}

function getGitUriRef(uri: vscode.Uri): string | undefined {
  const query = parseGitUriQuery(uri.query);
  return typeof query?.ref === 'string' ? query.ref : undefined;
}

function isWorkingTreeOrIndexRef(ref: string | undefined): boolean {
  return ref === '~' || ref === 'HEAD' || ref === '';
}

function getNativeWorkingTreeTitle(gitUri: vscode.Uri, fileUri: vscode.Uri): string {
  const fileName = vscode.workspace.asRelativePath(fileUri, false) || fileUri.path;
  const ref = getGitUriRef(gitUri);

  if (ref === '~') {
    return `${fileName} (Working Tree)`;
  }

  if (ref === 'HEAD' || ref === '') {
    return `${fileName} (Index)`;
  }

  return fileName;
}

export function deactivate(): void {}
