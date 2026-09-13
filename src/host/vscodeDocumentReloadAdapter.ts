import * as vscode from 'vscode';
import type { DocumentRevisionDto } from '../protocol/documentSession';

export type VscodeDocumentReloadAdapter = {
  reloadFromDisk(): Promise<DocumentRevisionDto>;
};

export type VscodeDocumentReloadAdapterOptions = {
  /** The custom editor that initiated the request must still own the active tab. */
  isTargetEditorActive(): boolean;
};

/**
 * Uses VS Code's active-editor revert command without opening or revealing a
 * different editor. VS Code exposes no resource-bound revert for text documents,
 * so the dispatch guard refuses to run after the initiating custom editor loses
 * activation or while another dirty document could be harmed by an activation race.
 */
export function createVscodeDocumentReloadAdapter(
  document: vscode.TextDocument,
  options: VscodeDocumentReloadAdapterOptions
): VscodeDocumentReloadAdapter {
  const isTargetDocumentActive = (): boolean => {
    if (!options.isTargetEditorActive()) return false;
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
