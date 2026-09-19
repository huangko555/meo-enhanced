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
 * so the synchronous dispatch guard binds the command to the initiating active
 * custom editor. Unrelated dirty documents do not participate in this decision.
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
    return vscode.commands.executeCommand('workbench.action.files.revert');
  };

  const waitForReloadConfirmation = async (): Promise<void> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!document.isDirty) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('VS Code did not confirm that the target document was reloaded');
  };

  return {
    async reloadFromDisk() {
      try {
        await executeTargetRevert();
        await waitForReloadConfirmation();
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
