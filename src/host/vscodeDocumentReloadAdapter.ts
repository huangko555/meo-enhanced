import * as vscode from 'vscode';
import type { DocumentRevisionDto } from '../protocol/documentSession';

export type VscodeDocumentReloadAdapter = {
  reloadFromDisk(): Promise<DocumentRevisionDto>;
};

/**
 * Reveals the target before using VS Code's active-editor revert command. VS Code
 * exposes no resource-bound revert for text documents, so the synchronous
 * dispatch guard refuses to run while another dirty document could be harmed.
 */
export function createVscodeDocumentReloadAdapter(
  document: vscode.TextDocument
): VscodeDocumentReloadAdapter {
  const isTargetDocumentActive = (): boolean => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uri = (input as { readonly uri?: vscode.Uri } | undefined)?.uri;
    return uri?.toString() === document.uri.toString();
  };

  const executeTargetRevert = (): Thenable<unknown> => {
    if (!isTargetDocumentActive()) {
      throw new Error('the target document is no longer active');
    }
    const targetUri = document.uri.toString();
    const ambiguousDirtyDocument = vscode.workspace.textDocuments.some((candidate) => (
      candidate.isDirty && candidate.uri.toString() !== targetUri
    ));
    if (ambiguousDirtyDocument) {
      throw new Error('another dirty document makes the active-editor revert unsafe');
    }
    return vscode.commands.executeCommand('workbench.action.files.revert');
  };

  return {
    async reloadFromDisk() {
      try {
        await vscode.commands.executeCommand('vscode.open', document.uri);
        await executeTargetRevert();
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
