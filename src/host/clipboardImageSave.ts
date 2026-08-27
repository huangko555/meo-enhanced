import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export type ClipboardImageFileRequest = {
  readonly documentFsPath: string;
  readonly workspaceFsPath?: string;
  readonly configuredFolder?: string;
  readonly requestedFileName: string;
  readonly contents: Uint8Array;
};

export type SavedClipboardImageFile = {
  readonly relativePath: string;
};

export async function saveClipboardImageFile(
  request: ClipboardImageFileRequest
): Promise<SavedClipboardImageFile> {
  const documentDirectory = path.dirname(path.resolve(request.documentFsPath));
  const configuredFolder = request.configuredFolder?.trim();
  const baseDirectory = configuredFolder && request.workspaceFsPath
    ? path.resolve(request.workspaceFsPath)
    : documentDirectory;
  const relativeFolder = configuredFolder || 'assets';
  const targetDirectory = resolveContainedPath(baseDirectory, relativeFolder, 'Image folder');
  const requestedFileName = normalizeFileName(request.requestedFileName);

  await mkdir(targetDirectory, { recursive: true });
  const extension = path.extname(requestedFileName);
  const stem = requestedFileName.slice(0, requestedFileName.length - extension.length);

  for (let suffix = 0; ; suffix += 1) {
    const candidateName = suffix === 0 ? requestedFileName : `${stem}-${suffix}${extension}`;
    const candidatePath = resolveContainedPath(targetDirectory, candidateName, 'Image file name');
    let handle;
    try {
      handle = await open(candidatePath, 'wx');
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }

    try {
      await handle.writeFile(request.contents);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(candidatePath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return {
      relativePath: path.relative(documentDirectory, candidatePath).replace(/\\/g, '/')
    };
  }
}

function normalizeFileName(value: string): string {
  if (!value || value === '.' || value === '..' || path.basename(value) !== value || /[\\/]/.test(value)) {
    throw new Error('Image file name must be a single safe path segment');
  }
  return value;
}

function resolveContainedPath(root: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its configured root`);
  }
  return target;
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
