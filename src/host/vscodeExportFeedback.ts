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

export async function runVscodeExportWithFeedback(
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
    targetUri = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: strings.title
      },
      async (progress) => {
        progress.report({ message: strings.progress.selectingDestination });
        // Establish the notification before the native save dialog starts. On
        // Windows the dialog can disappear before its promise finishes settling.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const selectedUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(replaceFileExtension(options.sourceDocumentUri.fsPath, options.format)),
          filters: options.format === 'html'
            ? { HTML: ['html', 'htm'] }
            : { PDF: ['pdf'] },
          saveLabel: strings.saveLabel
        });
        if (!selectedUri) return undefined;

        progress.report({ message: strings.progress.preparingExport });
        await task({
          targetUri: selectedUri,
          report: (stage) => progress.report({ message: strings.progress[stage] })
        });
        return selectedUri;
      }
    );
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
