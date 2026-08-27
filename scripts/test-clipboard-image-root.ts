import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveClipboardImageFile } from '../src/host/clipboardImageSave';
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

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'meo-clipboard-image-'));
try {
  const workspacePath = path.join(tempRoot, 'workspace');
  const documentDirectory = path.join(workspacePath, 'notes');
  const markdownPath = path.join(documentDirectory, 'draft.md');
  const first = await saveClipboardImageFile({
    documentFsPath: markdownPath,
    workspaceFsPath: workspacePath,
    configuredFolder: undefined,
    requestedFileName: 'pasted.png',
    contents: Buffer.from('first')
  });
  if (first.relativePath !== 'assets/pasted.png') {
    throw new Error(`default image path was ${JSON.stringify(first.relativePath)}`);
  }

  await writeFile(path.join(documentDirectory, 'assets', 'pasted-1.png'), 'existing');
  const [second, third] = await Promise.all([
    saveClipboardImageFile({
      documentFsPath: markdownPath,
      workspaceFsPath: workspacePath,
      configuredFolder: undefined,
      requestedFileName: 'pasted.png',
      contents: Buffer.from('second')
    }),
    saveClipboardImageFile({
      documentFsPath: markdownPath,
      workspaceFsPath: workspacePath,
      configuredFolder: undefined,
      requestedFileName: 'pasted.png',
      contents: Buffer.from('third')
    })
  ]);
  const collisionPaths = [second.relativePath, third.relativePath].sort();
  if (JSON.stringify(collisionPaths) !== JSON.stringify(['assets/pasted-2.png', 'assets/pasted-3.png'])) {
    throw new Error(`collision paths were ${JSON.stringify(collisionPaths)}`);
  }
  if ((await readFile(path.join(documentDirectory, 'assets', 'pasted.png'), 'utf8')) !== 'first') {
    throw new Error('the first image was overwritten');
  }
  if ((await readFile(path.join(documentDirectory, 'assets', 'pasted-1.png'), 'utf8')) !== 'existing') {
    throw new Error('an existing collision was overwritten');
  }

  const configured = await saveClipboardImageFile({
    documentFsPath: markdownPath,
    workspaceFsPath: workspacePath,
    configuredFolder: 'media/images',
    requestedFileName: 'configured.png',
    contents: Buffer.from('configured')
  });
  if (configured.relativePath !== '../media/images/configured.png') {
    throw new Error(`workspace-relative configured path was ${JSON.stringify(configured.relativePath)}`);
  }

  for (const unsafe of ['../outside', '/absolute', 'C:\\absolute']) {
    let rejected = false;
    try {
      await saveClipboardImageFile({
        documentFsPath: markdownPath,
        workspaceFsPath: workspacePath,
        configuredFolder: unsafe,
        requestedFileName: 'unsafe.png',
        contents: Buffer.from('unsafe')
      });
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`unsafe configured folder was accepted: ${unsafe}`);
    }
  }

  for (const unsafeName of ['../outside.png', 'nested/file.png', '..\\outside.png']) {
    let rejected = false;
    try {
      await saveClipboardImageFile({
        documentFsPath: markdownPath,
        workspaceFsPath: workspacePath,
        configuredFolder: undefined,
        requestedFileName: unsafeName,
        contents: Buffer.from('unsafe')
      });
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`unsafe image file name was accepted: ${unsafeName}`);
    }
  }

  const externalDirectory = path.join(tempRoot, 'external');
  await mkdir(externalDirectory, { recursive: true });
  const linkedAssets = path.join(documentDirectory, 'linked-assets');
  await symlink(externalDirectory, linkedAssets, process.platform === 'win32' ? 'junction' : 'dir');
  let linkedFolderRejected = false;
  try {
    await saveClipboardImageFile({
      documentFsPath: markdownPath,
      workspaceFsPath: workspacePath,
      configuredFolder: 'notes/linked-assets',
      requestedFileName: 'escaped.png',
      contents: Buffer.from('escaped')
    });
  } catch {
    linkedFolderRejected = true;
  }
  if (!linkedFolderRejected) {
    throw new Error('a linked image folder escaping the workspace was accepted');
  }
  let escapedFileExists = true;
  try {
    await readFile(path.join(externalDirectory, 'escaped.png'));
  } catch (error) {
    escapedFileExists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (escapedFileExists) {
    throw new Error('a linked image folder wrote outside the workspace');
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('clipboard image root checks passed');
