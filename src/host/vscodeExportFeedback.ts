import * as path from 'node:path';
import * as vscode from 'vscode';
import type { UiLanguage } from '../foundation/uiLanguage';

export type VscodeExportFormat = 'html' | 'pdf';
export type VscodeExportProgressStage =
  | 'selectingDestination'
  | 'preparingExport'
  | 'writingHtml'
  | 'renderingPdf';

type VscodeExportStrings = {
  readonly title: string;
  readonly saveLabel: string;
  readonly completed: string;
  readonly queuedRetry: string;
  readonly alreadyRunning: string;
  readonly failed: (message: string) => string;
  readonly completionActionFailed: (message: string) => string;
  readonly open: string;
  readonly reveal: string;
  readonly progress: Readonly<Record<VscodeExportProgressStage, string>>;
};

type VscodeExportTaskContext = {
  readonly targetUri: vscode.Uri;
  readonly report: (stage: VscodeExportProgressStage) => void;
};

export type VscodeExportOutcome = 'busy' | 'cancelled' | 'completed' | 'failed';

type VscodeExportAttemptResult =
  | { readonly outcome: 'cancelled' | 'failed' }
  | { readonly outcome: 'completed'; readonly targetUri: vscode.Uri };

type ActiveExportPhase = 'idle' | 'selectingDestination' | 'exporting';

type PendingExportRequest = {
  readonly options: {
    readonly sourceDocumentUri: vscode.Uri;
    readonly format: VscodeExportFormat;
    readonly uiLanguage: UiLanguage;
  };
  readonly task: (context: VscodeExportTaskContext) => Promise<void>;
  readonly resolve: (outcome: VscodeExportOutcome) => void;
};

// On Windows the native dialog can disappear before showSaveDialog settles.
// Serialize requests and retain the latest retry so a click in that gap is not lost.
let exportRequestActive = false;
let queuedCancelledExportRetry: PendingExportRequest | null = null;
let activeExportPhase: ActiveExportPhase = 'idle';
let activeExportProgress: vscode.Progress<{ message?: string; increment?: number }> | null = null;

export function runVscodeExportWithFeedback(
  options: {
    readonly sourceDocumentUri: vscode.Uri;
    readonly format: VscodeExportFormat;
    readonly uiLanguage: UiLanguage;
  },
  task: (context: VscodeExportTaskContext) => Promise<void>
): Promise<VscodeExportOutcome> {
  return new Promise<VscodeExportOutcome>((resolve) => {
    const request = { options, task, resolve } satisfies PendingExportRequest;
    if (exportRequestActive) {
      const strings = getStrings(options.uiLanguage, options.format);
      if (activeExportPhase === 'selectingDestination') {
        queuedCancelledExportRetry?.resolve('cancelled');
        queuedCancelledExportRetry = request;
        activeExportProgress?.report({ message: strings.queuedRetry });
      } else {
        activeExportProgress?.report({ message: strings.alreadyRunning });
        request.resolve('busy');
      }
      return;
    }

    exportRequestActive = true;
    void drainExportRequests(request);
  });
}

async function drainExportRequests(initialRequest: PendingExportRequest): Promise<void> {
  let request: PendingExportRequest | null = initialRequest;
  let completedExport: { readonly targetUri: vscode.Uri; readonly strings: VscodeExportStrings } | null = null;
  try {
    while (request) {
      const result = await performVscodeExportWithFeedback(request.options, request.task);
      request.resolve(result.outcome);
      if (result.outcome === 'completed') {
        completedExport = {
          targetUri: result.targetUri,
          strings: getStrings(request.options.uiLanguage, request.options.format)
        };
      }

      const queued = queuedCancelledExportRetry;
      queuedCancelledExportRetry = null;
      if (result.outcome === 'cancelled' && queued) {
        request = queued;
      } else {
        queued?.resolve('cancelled');
        request = null;
      }
    }
  } finally {
    exportRequestActive = false;
    activeExportPhase = 'idle';
    activeExportProgress = null;
  }

  if (completedExport) {
    void showCompletedExportFeedback(completedExport.targetUri, completedExport.strings);
  }
}

async function performVscodeExportWithFeedback(
  options: {
    readonly sourceDocumentUri: vscode.Uri;
    readonly format: VscodeExportFormat;
    readonly uiLanguage: UiLanguage;
  },
  task: (context: VscodeExportTaskContext) => Promise<void>
): Promise<VscodeExportAttemptResult> {
  const strings = getStrings(options.uiLanguage, options.format);
  let targetUri: vscode.Uri | undefined;
  activeExportPhase = 'selectingDestination';

  try {
    let resolveDestination!: (uri: vscode.Uri | undefined) => void;
    let rejectDestination!: (error: unknown) => void;
    const destination = new Promise<vscode.Uri | undefined>((resolve, reject) => {
      resolveDestination = resolve;
      rejectDestination = reject;
    });
    const progressOperation = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: strings.title
      },
      async (progress) => {
        activeExportProgress = progress;
        try {
          progress.report({ message: strings.progress.selectingDestination });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const selectedUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(replaceFileExtension(options.sourceDocumentUri.fsPath, options.format)),
            filters: options.format === 'html'
              ? { HTML: ['html', 'htm'] }
              : { PDF: ['pdf'] },
            saveLabel: strings.saveLabel
          });
          resolveDestination(selectedUri);
          if (!selectedUri) return undefined;

          activeExportPhase = 'exporting';
          progress.report({ message: strings.progress.preparingExport });
          await task({
            targetUri: selectedUri,
            report: (stage) => progress.report({ message: strings.progress[stage] })
          });
          return selectedUri;
        } catch (error) {
          rejectDestination(error);
          throw error;
        } finally {
          if (activeExportProgress === progress) activeExportProgress = null;
        }
      }
    );
    void Promise.resolve(progressOperation).catch(rejectDestination);
    const selectedUri = await destination;
    if (!selectedUri) return { outcome: 'cancelled' };
    targetUri = await progressOperation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Export failed');
    void vscode.window.showErrorMessage(strings.failed(message));
    return { outcome: 'failed' };
  }
  if (!targetUri) return { outcome: 'cancelled' };

  return { outcome: 'completed', targetUri };
}

async function showCompletedExportFeedback(
  targetUri: vscode.Uri,
  strings: VscodeExportStrings
): Promise<void> {
  try {
    const selected = await vscode.window.showInformationMessage(
      strings.completed,
      strings.open,
      strings.reveal
    );
    if (selected === strings.open) {
      const opened = await vscode.env.openExternal(targetUri);
      if (!opened) throw new Error('The exported file could not be opened.');
    } else if (selected === strings.reveal) {
      try {
        await vscode.commands.executeCommand('revealFileInOS', targetUri);
      } catch {
        const opened = await vscode.env.openExternal(vscode.Uri.file(path.dirname(targetUri.fsPath)));
        if (!opened) throw new Error('The export folder could not be opened.');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Export action failed');
    void vscode.window.showErrorMessage(strings.completionActionFailed(message));
  }
}

function getStrings(uiLanguage: UiLanguage, format: VscodeExportFormat): VscodeExportStrings {
  const label = format.toUpperCase();
  if (uiLanguage === 'zh-CN') {
    return {
      title: `正在导出 Markdown 为 ${label}`,
      saveLabel: `导出 ${label}`,
      completed: `${label} 导出完成。`,
      queuedRetry: '正在等待系统关闭上一次保存窗口…',
      alreadyRunning: '当前已有导出正在进行，请稍候…',
      failed: (message) => `${label} 导出失败：${message}`,
      completionActionFailed: (message) => `${label} 已导出，但无法执行完成操作：${message}`,
      open: '直接打开',
      reveal: '打开所在文件夹',
      progress: {
        selectingDestination: '等待选择保存位置…',
        preparingExport: `正在准备 ${label} 导出…`,
        writingHtml: '正在写入 HTML…',
        renderingPdf: '正在生成 PDF…'
      }
    };
  }

  return {
    title: `Exporting Markdown to ${label}`,
    saveLabel: `Export ${label}`,
    completed: `${label} export completed.`,
    queuedRetry: 'Waiting for the previous save dialog to close…',
    alreadyRunning: 'An export is already in progress. Please wait…',
    failed: (message) => `${label} export failed: ${message}`,
    completionActionFailed: (message) => `${label} was exported, but the completion action failed: ${message}`,
    open: 'Open',
    reveal: 'Show in Folder',
    progress: {
      selectingDestination: 'Waiting for an output location…',
      preparingExport: `Preparing ${label} export…`,
      writingHtml: 'Writing HTML…',
      renderingPdf: 'Rendering PDF…'
    }
  };
}

function replaceFileExtension(filePath: string, format: VscodeExportFormat): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.${format}`);
}
