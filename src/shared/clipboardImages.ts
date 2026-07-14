import path from 'node:path';

export function resolveClipboardImageSaveRoot(documentFsPath: string, workspaceFsPath?: string): string {
  return workspaceFsPath || path.dirname(documentFsPath);
}
