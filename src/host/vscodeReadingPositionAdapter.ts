import * as vscode from 'vscode';
import {
  createReadingPositionMemory,
  type ReadingPositionPort
} from '../application/readingPositionMemory';

export const READING_POSITION_WORKSPACE_STATE_KEY = 'readingPositionsByDocument.v2';
const workspaceStateWriteQueues = new WeakMap<object, Promise<void>>();

const getStableDocumentKey = (document: vscode.TextDocument): string | null => {
  if (document.isUntitled || document.uri.scheme !== 'file') return null;
  return document.uri.with({ fragment: '', query: '' }).toString();
};

/** Adapts one stable VS Code document and workspaceState to the persistence owner. */
export function createVscodeReadingPositionAdapter(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  isEnabled: () => boolean
): ReadingPositionPort {
  return createReadingPositionMemory({
    documentKey: getStableDocumentKey(document),
    getDocumentLineCount: () => document.lineCount,
    isEnabled,
    storage: {
      read: () => context.workspaceState.get(READING_POSITION_WORKSPACE_STATE_KEY),
      update: (transform) => {
        const stateOwner = context.workspaceState as object;
        const previous = workspaceStateWriteQueues.get(stateOwner) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => Promise.resolve(
          context.workspaceState.update(
            READING_POSITION_WORKSPACE_STATE_KEY,
            transform(context.workspaceState.get(READING_POSITION_WORKSPACE_STATE_KEY))
          )
        ));
        workspaceStateWriteQueues.set(stateOwner, next);
        return next;
      }
    }
  });
}
