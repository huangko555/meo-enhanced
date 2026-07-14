import path from 'node:path';
import { resolveClipboardImageSaveRoot } from '../src/shared/clipboardImages';

const documentPath = path.join('D:', 'notes', 'draft.md');
const standaloneRoot = resolveClipboardImageSaveRoot(documentPath);
if (standaloneRoot !== path.join('D:', 'notes')) {
  throw new Error(`standalone document image root was ${JSON.stringify(standaloneRoot)}`);
}

const workspaceRoot = path.join('D:', 'workspace');
if (resolveClipboardImageSaveRoot(documentPath, workspaceRoot) !== workspaceRoot) {
  throw new Error('workspace document did not preserve its workspace image root');
}

console.log('clipboard image root checks passed');
