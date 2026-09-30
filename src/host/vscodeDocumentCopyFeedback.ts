import * as vscode from 'vscode';
import type { UiLanguage } from '../foundation/uiLanguage';

/** The copy is already verified when this feedback starts; opening it is optional. */
export async function showSavedDocumentCopyFeedback(uri: vscode.Uri, language: UiLanguage): Promise<void> {
  const chinese = language === 'zh-CN';
  const open = chinese ? '打开副本' : 'Open Copy';
  const reveal = chinese ? '打开所在文件夹' : 'Open Containing Folder';
  const location = uri.fsPath || uri.toString();

  try {
    const selected = await vscode.window.showInformationMessage(
      (chinese ? '副本已保存：' : 'Copy saved: ') + location,
      open,
      reveal
    );
    if (selected === open) {
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    } else if (selected === reveal) {
      await vscode.commands.executeCommand('revealFileInOS', uri);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await vscode.window.showErrorMessage(
        (chinese ? '副本已保存，但无法执行所选操作：' : 'Copy saved, but the selected action failed: ') + detail
      );
    } catch { /* Feedback failure cannot undo the saved copy. */ }
  }
}