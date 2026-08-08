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
  return createPendingDraftRecovery({
    readCurrentText: () => document.getText(),
    applyDraft: async (expectedCurrentText, draftText) => {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(expectedCurrentText.length)
      );
      noteOwnedFileChange(document.uri);
      edit.replace(document.uri, fullRange, draftText);
      return vscode.workspace.applyEdit(edit);
    }
  });
}
