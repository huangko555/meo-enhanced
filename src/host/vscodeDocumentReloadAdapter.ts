import * as vscode from 'vscode';
import type { DocumentRevisionDto } from '../protocol/documentSession';

export type VscodeDocumentReloadAdapter = {
  reloadFromDisk(): Promise<DocumentRevisionDto>;
};

/**
 * Reloads the active document through VS Code so its normal disk-revert
 * semantics remain the single source of truth for unsaved-buffer replacement.
 */
export function createVscodeDocumentReloadAdapter(
  document: vscode.TextDocument
): VscodeDocumentReloadAdapter {
  return {
    async reloadFromDisk() {
      try {
        await vscode.commands.executeCommand('workbench.action.files.revert');
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
