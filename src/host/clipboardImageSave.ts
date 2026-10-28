import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { expandImageStorage, imageFileNameCandidates } from '../application/imageStorage';
import type { ImageStoragePreferences } from '../foundation/imageStorage';

export type ClipboardImageFileRequest = {
  readonly documentFsPath: string;
  readonly workspaceFsPath?: string;
  readonly configuredFolder?: string;
  readonly imageStorage?: ImageStoragePreferences;
  readonly extension: string;
  readonly contents: Uint8Array;
};

export type SavedClipboardImageFile = {
  readonly relativePath: string;
  readonly fileName: string;
};

export type ClipboardImageDirectoryRequest = Pick<ClipboardImageFileRequest,
  'documentFsPath' | 'workspaceFsPath' | 'configuredFolder' | 'imageStorage'>;

/** Used by both settings previews and clipboard writes; resolving never creates directories. */
export function resolveClipboardImageDirectory(request: ClipboardImageDirectoryRequest) {
  const documentDirectory = path.dirname(path.resolve(request.documentFsPath));
  if (request.imageStorage) {
    const fileBasename = path.basename(request.documentFsPath);
    const fileExtname = path.extname(fileBasename);
    const expanded = expandImageStorage(request.imageStorage, {
      fileDirname: documentDirectory, fileBasename, fileExtname,
      fileBasenameNoExtension: fileBasename.slice(0, fileBasename.length - fileExtname.length)
    });
    if (expanded.includes('\0') || /^[a-z]:(?![\\/])/i.test(expanded)) {
      throw new Error('Enter a valid folder path.');
    }
    const targetDirectory = request.imageStorage.mode === 'advanced'
      ? path.resolve(documentDirectory, expanded)
      : resolveContainedPath(documentDirectory, expanded, 'Image folder');
    if (process.platform === 'win32') {
      for (const segment of targetDirectory.slice(path.parse(targetDirectory).root.length).split(path.sep)) {
        if (isUnsafeWindowsSegment(segment)) {
          throw new Error('The folder path contains a name that Windows cannot use.');
        }
      }
    }
    // An advanced rule explicitly authorizes its destination. Walk from the volume root
    // so a junction anywhere along that destination cannot silently redirect the write.
    const baseDirectory = request.imageStorage.mode === 'advanced'
      ? path.parse(targetDirectory).root : documentDirectory;
    return { documentDirectory, baseDirectory, targetDirectory };
  }
  const configuredFolder = request.configuredFolder?.trim();
  const baseDirectory = configuredFolder && request.workspaceFsPath
    ? path.resolve(request.workspaceFsPath) : documentDirectory;
  return { documentDirectory, baseDirectory,
    targetDirectory: resolveContainedPath(baseDirectory, configuredFolder || 'assets', 'Image folder') };
}

export async function saveClipboardImageFile(
  request: ClipboardImageFileRequest
): Promise<SavedClipboardImageFile> {
  const { documentDirectory, baseDirectory, targetDirectory } = resolveClipboardImageDirectory(request);
  // Validate before creating directories, then use the same naming rule as the preview.
  fileNameCandidates(request, []).next();

  if (baseDirectory !== path.parse(baseDirectory).root) await mkdir(baseDirectory, { recursive: true });
  // Bun omits the separator for Windows volume roots; retain an absolute root.
  const canonicalBaseDirectory = (await realpath(baseDirectory)).replace(/^([a-z]:)$/i, '$1' + path.sep);
  await ensureCanonicalDirectory(canonicalBaseDirectory, baseDirectory, targetDirectory);
  const candidates = fileNameCandidates(request, await readdir(targetDirectory));
  for (const candidateName of candidates) {
    const candidatePath = resolveContainedPath(targetDirectory, candidateName, 'Image file name');
    let handle;
    try {
      await ensureCanonicalDirectory(canonicalBaseDirectory, baseDirectory, targetDirectory);
      handle = await open(
        candidatePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
      );
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
      relativePath: path.relative(documentDirectory, candidatePath).replace(/\\/g, '/'), fileName: candidateName
    };
  }
  throw new Error('No available image file name.');
}

function fileNameCandidates(request: ClipboardImageDirectoryRequest & { readonly extension: string }, existingNames: readonly string[]) {
  return imageFileNameCandidates({ naming: request.imageStorage?.naming ?? 'documentSequence',
    documentName: path.parse(request.documentFsPath).name, extension: request.extension,
    timestamp: Date.now(), existingNames });
}

/** A non-reserving PNG example; neither previews nor opening settings create directories. */
export async function previewClipboardImagePath(request: ClipboardImageDirectoryRequest): Promise<string> {
  const { targetDirectory } = resolveClipboardImageDirectory(request);
  const names = await readdir(targetDirectory).catch(error => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  return path.join(targetDirectory, fileNameCandidates({ ...request, extension: 'png' }, names).next().value!);
}

async function ensureCanonicalDirectory(
  canonicalBaseDirectory: string,
  baseDirectory: string,
  targetDirectory: string
): Promise<void> {
  const relative = path.relative(baseDirectory, targetDirectory);
  let current = baseDirectory;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      await mkdir(current).catch(error => { if (!isAlreadyExistsError(error)) throw error; });
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink()) {
      throw new Error('Image folder must not traverse a symbolic link or junction');
    }
    if (!entry.isDirectory()) {
      throw new Error('Image folder must contain only directories');
    }
    assertContainedPath(canonicalBaseDirectory, await realpath(current), 'Image folder');
  }
}

function isUnsafeWindowsSegment(value: string): boolean {
  return /[<>:"|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function resolveContainedPath(root: string, relativePath: string, label: string): string {
  if (!relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || /^[a-z]:/i.test(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const target = path.resolve(root, relativePath);
  assertContainedPath(root, target, label);
  return target;
}

function assertContainedPath(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its configured root`);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
