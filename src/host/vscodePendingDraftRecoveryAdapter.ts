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
      let ownedVersion = recovery.version;
      let ownedText = copyText;
      await vscode.window.showTextDocument(recovery, { preview: false });
      return {
        replace: async (nextText) => {
          // Never overwrite a recovery buffer after the user edited or closed
          // it. Only this drain's exact still-owned revision may be updated.
          if (!vscode.workspace.textDocuments.includes(recovery)
            || recovery.version !== ownedVersion || recovery.getText() !== ownedText) return false;
          if (nextText === ownedText) return true;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(recovery.uri, new vscode.Range(recovery.positionAt(0), recovery.positionAt(ownedText.length)), nextText);
          if (!await vscode.workspace.applyEdit(edit) || recovery.getText() !== nextText) return false;
          ownedVersion = recovery.version;
          ownedText = nextText;
          return true;
        }
      };
    }
  });
}
