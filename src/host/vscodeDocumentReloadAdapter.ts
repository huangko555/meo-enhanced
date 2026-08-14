import * as vscode from 'vscode';
import type { DocumentRevisionDto } from '../protocol/documentSession';

export type VscodeDocumentReloadAdapter = {
  reloadFromDisk(): Promise<DocumentRevisionDto>;
};

/**
 * Reveals and validates the target document before using VS Code's active-editor
 * revert command. The command has no resource argument, so any focus mismatch
 * fails closed instead of clearing recovery state for an unreloaded document.
 */
export function createVscodeDocumentReloadAdapter(
  document: vscode.TextDocument
): VscodeDocumentReloadAdapter {
  const isTargetDocumentActive = (): boolean => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uri = (input as { readonly uri?: vscode.Uri } | undefined)?.uri;
    return uri?.toString() === document.uri.toString();
  };

  return {
    async reloadFromDisk() {
      try {
        await vscode.commands.executeCommand('vscode.open', document.uri);
        if (!isTargetDocumentActive()) {
          throw new Error('the target document is no longer active');
        }
        await vscode.commands.executeCommand('workbench.action.files.revert');
        if (!isTargetDocumentActive() || document.isDirty) {
          throw new Error('VS Code did not confirm that the target document was reloaded');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'VS Code did not reload the document';
        throw new Error(`Could not reload the document from disk: ${message}`);
      }
      return {
        version: document.version,
        text: document.getText().replace(/\r\n/g, '\n')
      };
    }
  };
}
