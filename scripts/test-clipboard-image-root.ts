import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveClipboardImageFile } from '../src/host/clipboardImageSave';
import { resolveClipboardImageSaveRoot } from '../src/shared/clipboardImages';

const unsafeFolders = ['../outside', '/absolute', 'C:\\absolute', 'C:/absolute', 'C:relative',
  '\\absolute', '\\\\server\\share', '//server/share', '\\\\?\\C:\\absolute'];
const resolverModule = pathToFileURL(path.resolve(import.meta.dir, '../src/host/clipboardImageSave.ts')).href;
// Isolate the path mock so both OS contracts run without replacing the real filesystem path API below.
for (const flavor of ['posix', 'win32'] as const) {
  const result = spawnSync(process.execPath, ['--eval', `
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    import path from 'node:path';
    const paths = path[${JSON.stringify(flavor)}];
    mock.module('node:path', () => ({ ...paths, default: paths, posix: path.posix, win32: path.win32 }));
    const { resolveClipboardImageDirectory } = await import(${JSON.stringify(resolverModule)});
    const workspaceFsPath = ${JSON.stringify(flavor === 'posix' ? '/workspace' : 'C:\\workspace')};
    const documentFsPath = paths.join(workspaceFsPath, 'notes', 'draft.md');
    const context = { documentFsPath, workspaceFsPath };
    for (const configuredFolder of ${JSON.stringify(unsafeFolders)}) {
      assert.throws(() => resolveClipboardImageDirectory({ ...context, configuredFolder }),
        /relative path|configured root/, 'unsafe legacy folder: ' + configuredFolder);
      for (const mode of ['default', 'perDocument']) {
        assert.throws(() => resolveClipboardImageDirectory({ ...context,
          imageStorage: { mode, folder: configuredFolder, rule: 'assets' } }),
          /inside the document directory/, 'unsafe basic folder: ' + configuredFolder);
      }
    }
    assert.equal(resolveClipboardImageDirectory({ ...context, configuredFolder: 'media/images' }).targetDirectory,
      paths.join(workspaceFsPath, 'media', 'images'));
    assert.equal(resolveClipboardImageDirectory({ documentFsPath, configuredFolder: 'media/images' }).targetDirectory,
      paths.join(workspaceFsPath, 'notes', 'media', 'images'));
    const absoluteRule = paths.join(workspaceFsPath, 'shared images');
    assert.equal(resolveClipboardImageDirectory({ ...context,
      imageStorage: { mode: 'advanced', folder: 'assets', rule: absoluteRule } }).targetDirectory, absoluteRule);
    assert.equal(resolveClipboardImageDirectory({ ...context,
      imageStorage: { mode: 'advanced', folder: 'assets', rule: '../shared images' } }).targetDirectory, absoluteRule);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${flavor} image folder contract failed:\n${result.stderr || result.error || result.stdout}`);
}

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
    extension: 'png',
    contents: Buffer.from('first')
  });
  if (first.relativePath !== 'assets/draft-1.png') {
    throw new Error(`default image path was ${JSON.stringify(first.relativePath)}`);
  }

  await writeFile(path.join(documentDirectory, 'assets', 'draft-4.png'), 'existing');
  const [second, third] = await Promise.all([
    saveClipboardImageFile({
      documentFsPath: markdownPath,
      workspaceFsPath: workspacePath,
      configuredFolder: undefined,
      extension: 'png',
      contents: Buffer.from('second')
    }),
    saveClipboardImageFile({
      documentFsPath: markdownPath,
      workspaceFsPath: workspacePath,
      configuredFolder: undefined,
      extension: 'png',
      contents: Buffer.from('third')
    })
  ]);
  const collisionPaths = [second.relativePath, third.relativePath].sort();
  if (JSON.stringify(collisionPaths) !== JSON.stringify(['assets/draft-5.png', 'assets/draft-6.png'])) {
    throw new Error(`collision paths were ${JSON.stringify(collisionPaths)}`);
  }
  if ((await readFile(path.join(documentDirectory, 'assets', 'draft-1.png'), 'utf8')) !== 'first') {
    throw new Error('the first image was overwritten');
  }
  if ((await readFile(path.join(documentDirectory, 'assets', 'draft-4.png'), 'utf8')) !== 'existing') {
    throw new Error('an existing collision was overwritten');
  }

  const configured = await saveClipboardImageFile({
    documentFsPath: markdownPath,
    workspaceFsPath: workspacePath,
    configuredFolder: 'media/images',
    extension: 'png',
    contents: Buffer.from('configured')
  });
  if (configured.relativePath !== '../media/images/draft-1.png') {
    throw new Error(`workspace-relative configured path was ${JSON.stringify(configured.relativePath)}`);
  }

  for (const unsafe of unsafeFolders) {
    let rejected = false;
    try {
      await saveClipboardImageFile({
        documentFsPath: markdownPath,
        workspaceFsPath: workspacePath,
        configuredFolder: unsafe,
        extension: 'png',
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
        extension: unsafeName,
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
      configuredFolder: 'notes/linked-assets/new/subdir',
      extension: 'png',
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
  let escapedDirectoryExists = true;
  try {
    await access(path.join(externalDirectory, 'new'));
  } catch (error) {
    escapedDirectoryExists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (escapedDirectoryExists) {
    throw new Error('a linked image folder created directories outside the workspace');
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('clipboard image root checks passed');
