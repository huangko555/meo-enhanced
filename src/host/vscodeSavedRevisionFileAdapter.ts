import * as vscode from 'vscode';
import type {
  SavedRevisionFileAdapter,
  SavedRevisionFileReadResult
} from '../application/savedRevisionLifecycle';

const SAVED_REVISION_MAX_BYTES = 1024 * 1024;

/** Reads and validates one persisted Saved Revision through VS Code. */
export function createVscodeSavedRevisionFileAdapter(documentUri: vscode.Uri): SavedRevisionFileAdapter {
  return {
    async read(): Promise<SavedRevisionFileReadResult> {
      if (documentUri.scheme !== 'file') return { ok: false, reason: 'not-file' };
      try {
        const stat = await vscode.workspace.fs.stat(documentUri);
        if (stat.size > SAVED_REVISION_MAX_BYTES) return { ok: false, reason: 'too-large' };
      } catch {
        // Stat is only a fast-path budget check. readFile remains authoritative
        // for providers that cannot stat a file but can still read it.
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(documentUri);
        if (bytes.byteLength > SAVED_REVISION_MAX_BYTES) return { ok: false, reason: 'too-large' };
        if (bytes.includes(0)) return { ok: false, reason: 'binary' };
        const text = Buffer.from(bytes).toString('utf8');
        return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
      } catch {
        return { ok: false, reason: 'error' };
      }
    }
  };
}
