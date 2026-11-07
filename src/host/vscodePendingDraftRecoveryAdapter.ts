import * as vscode from 'vscode';
import {
  createPendingDraftRecovery,
  type PendingDraftRecovery
} from '../application/pendingDraftRecovery';

export type VscodePendingDraftRecoveryAdapterParams = {
  readonly document: vscode.TextDocument;
  readonly noteOwnedFileChange: (uri: vscode.Uri) => void;
};

/** Connects Pending Draft recovery to one VS Code document. */
export function createVscodePendingDraftRecoveryAdapter(
  params: VscodePendingDraftRecoveryAdapterParams
): PendingDraftRecovery {
  const { document, noteOwnedFileChange } = params;
  const isOriginalDocumentOpen = (): boolean => vscode.workspace.textDocuments.includes(document);
  return createPendingDraftRecovery({
    readCurrentRevision: () => isOriginalDocumentOpen()
      ? { version: document.version, text: document.getText() } : null,
    applyDraft: async (expected, draftText) => {
      // A URI can be reopened as another TextDocument whose version has reset.
      // Only mutate this exact still-open instance at the recorded revision.
      if (!isOriginalDocumentOpen() || document.version !== expected.version
        || document.getText() !== expected.text) return false;
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(expected.text.length)
      );
      noteOwnedFileChange(document.uri);
      edit.replace(document.uri, fullRange, draftText);
      return vscode.workspace.applyEdit(edit);
    },
    preserveConflict: async (copyText) => {
      const recovery = await vscode.workspace.openTextDocument({ content: copyText, language: 'markdown' });
      await vscode.window.showTextDocument(recovery, { preview: false });
      return true;
    }
  });
}
