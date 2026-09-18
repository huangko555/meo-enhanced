import * as path from 'node:path';
import * as vscode from 'vscode';
import type { UiLanguage } from '../foundation/uiLanguage';

export type VscodeExportFormat = 'html' | 'pdf';
export type VscodeExportProgressStage =
  | 'collectingContent'
  | 'renderingDocument'
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
  const targetUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(replaceFileExtension(options.sourceDocumentUri.fsPath, options.format)),
    filters: options.format === 'html'
      ? { HTML: ['html', 'htm'] }
      : { PDF: ['pdf'] },
    saveLabel: strings.saveLabel
  });
  if (!targetUri) return 'cancelled';

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: strings.title
      },
      async (progress) => task({
        targetUri,
        report: (stage) => progress.report({ message: strings.progress[stage] })
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Export failed');
    void vscode.window.showErrorMessage(strings.failed(message));
    return 'failed';
  }

  const selected = await vscode.window.showInformationMessage(
    strings.completed,
    strings.open,
    strings.reveal
  );
  if (selected === strings.open) {
    await vscode.env.openExternal(targetUri);
  } else if (selected === strings.reveal) {
    await vscode.env.openExternal(vscode.Uri.file(path.dirname(targetUri.fsPath)));
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
        collectingContent: '正在获取编辑器内容…',
        renderingDocument: '正在生成导出文档…',
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
      collectingContent: 'Collecting editor content…',
      renderingDocument: 'Rendering export document…',
      writingHtml: 'Writing HTML…',
      renderingPdf: 'Rendering PDF…'
    }
  };
}

function replaceFileExtension(filePath: string, format: VscodeExportFormat): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.${format}`);
}
