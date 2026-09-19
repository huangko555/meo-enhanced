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
  readonly failed: (message: string) => string;
  readonly open: string;
  readonly reveal: string;
  readonly progress: Readonly<Record<VscodeExportProgressStage, string>>;
};

type VscodeExportTaskContext = {
  readonly targetUri: vscode.Uri;
  readonly report: (stage: VscodeExportProgressStage) => void;
};

export type VscodeExportOutcome = 'cancelled' | 'completed' | 'failed';

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
let activeDestinationProgress: vscode.Progress<{ message?: string; increment?: number }> | null = null;

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
      queuedCancelledExportRetry?.resolve('cancelled');
      queuedCancelledExportRetry = request;
      activeDestinationProgress?.report({
        message: getStrings(options.uiLanguage, options.format).queuedRetry
      });
      return;
    }

    exportRequestActive = true;
    void drainExportRequests(request);
  });
}

async function drainExportRequests(initialRequest: PendingExportRequest): Promise<void> {
  let request: PendingExportRequest | null = initialRequest;
  try {
    while (request) {
      const outcome = await performVscodeExportWithFeedback(request.options, request.task);
      request.resolve(outcome);

      const queued = queuedCancelledExportRetry;
      queuedCancelledExportRetry = null;
      if (outcome === 'cancelled' && queued) {
        request = queued;
      } else {
        queued?.resolve('cancelled');
        request = null;
      }
    }
  } finally {
    exportRequestActive = false;
  }
}

async function performVscodeExportWithFeedback(
  options: {
    readonly sourceDocumentUri: vscode.Uri;
    readonly format: VscodeExportFormat;
    readonly uiLanguage: UiLanguage;
  },
  task: (context: VscodeExportTaskContext) => Promise<void>
): Promise<VscodeExportOutcome> {
  const strings = getStrings(options.uiLanguage, options.format);
  let targetUri: vscode.Uri | undefined;

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
        try {
          progress.report({ message: strings.progress.selectingDestination });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          activeDestinationProgress = progress;
          let selectedUri: vscode.Uri | undefined;
          try {
            selectedUri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(replaceFileExtension(options.sourceDocumentUri.fsPath, options.format)),
              filters: options.format === 'html'
                ? { HTML: ['html', 'htm'] }
                : { PDF: ['pdf'] },
              saveLabel: strings.saveLabel
            });
          } finally {
            if (activeDestinationProgress === progress) activeDestinationProgress = null;
          }
          resolveDestination(selectedUri);
          if (!selectedUri) return undefined;

          progress.report({ message: strings.progress.preparingExport });
          await task({
            targetUri: selectedUri,
            report: (stage) => progress.report({ message: strings.progress[stage] })
          });
          return selectedUri;
        } catch (error) {
          rejectDestination(error);
          throw error;
        }
      }
    );
    void Promise.resolve(progressOperation).catch(rejectDestination);
    const selectedUri = await destination;
    if (!selectedUri) return 'cancelled';
    targetUri = await progressOperation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Export failed');
    void vscode.window.showErrorMessage(strings.failed(message));
    return 'failed';
  }
  if (!targetUri) return 'cancelled';

  const selected = await vscode.window.showInformationMessage(
    strings.completed,
    strings.open,
    strings.reveal
  );
  if (selected === strings.open) {
    await vscode.env.openExternal(targetUri);
  } else if (selected === strings.reveal) {
    try {
      await vscode.commands.executeCommand('revealFileInOS', targetUri);
    } catch {
      await vscode.env.openExternal(vscode.Uri.file(path.dirname(targetUri.fsPath)));
    }
  }
  return 'completed';
}

function getStrings(uiLanguage: UiLanguage, format: VscodeExportFormat): VscodeExportStrings {
  const label = format.toUpperCase();
  if (uiLanguage === 'zh-CN') {
    return {
      title: `正在导出 Markdown 为 ${label}`,
      saveLabel: `导出 ${label}`,
      completed: `${label} 导出完成。`,
      queuedRetry: '正在等待系统关闭上一次保存窗口…',
      failed: (message) => `${label} 导出失败：${message}`,
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
    failed: (message) => `${label} export failed: ${message}`,
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
