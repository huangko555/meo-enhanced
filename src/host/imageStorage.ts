import path from 'node:path';
import { defaultImageStorage, type ImageLocationState, type ImageStoragePreferences } from '../foundation/imageStorage';
import { resolveClipboardImageDirectory, type ClipboardImageDirectoryRequest } from './clipboardImageSave';
import type { ImageLocationRequest, ImageLocationResponse } from '../protocol/imageStorage';

export type ImageStorageContext = Omit<ClipboardImageDirectoryRequest, 'documentFsPath'> & {
  readonly documentFsPath: string | null;
};

function stateFor(context: ImageStorageContext, draft?: ImageStoragePreferences): ImageLocationState {
  const legacy = !draft && !context.imageStorage && !!context.configuredFolder?.trim();
  const preferences = draft ?? context.imageStorage ?? (legacy ? {
    ...defaultImageStorage, mode: 'advanced' as const,
    rule: context.workspaceFsPath ? path.resolve(context.workspaceFsPath, context.configuredFolder!.trim())
      : '${fileDirname}/' + context.configuredFolder!.trim().replace(/\\/g, '/')
  } : defaultImageStorage);
  let targetDirectory: string | null = null;
  let error: string | null = null;
  try {
    const resolved = resolveClipboardImageDirectory({
      ...context, documentFsPath: context.documentFsPath ?? path.resolve('document.md'),
      ...(draft ? { imageStorage: draft } : {})
    });
    if (context.documentFsPath) targetDirectory = resolved.targetDirectory;
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  return { preferences, documentPath: context.documentFsPath,
    documentName: context.documentFsPath ? path.parse(context.documentFsPath).name : '',
    targetDirectory, error, legacy };
}

/** One owner serializes configuration writes across panels and reuses duplicate results. */
export function createImageStorageHost(options: {
  read: (resource: string) => ImageStorageContext;
  write: (resource: string, preferences: ImageStoragePreferences) => Promise<void>;
  selectFolder: (resource: string, initialDirectory: string | null) => Promise<string | null>;
}) {
  let tail = Promise.resolve();
  const requests = new Map<string, { signature: string; response: Promise<ImageLocationResponse> }>();
  const fail = (requestId: string, cause: unknown): ImageLocationResponse => ({
    type: 'imageLocationResult', requestId,
    result: { ok: false, error: { code: 'operation-failed', message: cause instanceof Error ? cause.message : String(cause) } }
  });
  async function run(request: ImageLocationRequest, resource: string): Promise<ImageLocationResponse> {
    try {
      if (request.action === 'save') {
        const operation = tail.then(async () => {
          const state = stateFor(options.read(resource), request.preferences);
          if (state.error) throw new Error(state.error);
          await options.write(resource, request.preferences);
        });
        tail = operation.catch(() => undefined);
        await operation;
      }
      const state = stateFor(options.read(resource), request.action === 'preview' ? request.preferences : undefined);
      const selectedFolder = request.action === 'selectFolder'
        ? await options.selectFolder(resource, state.targetDirectory) : null;
      return { type: 'imageLocationResult', requestId: request.requestId, result: { ok: true, value: { state, selectedFolder } } };
    } catch (cause) { return fail(request.requestId, cause); }
  }
  return {
    handle(request: ImageLocationRequest, resource: string): Promise<ImageLocationResponse> {
      const signature = JSON.stringify([resource, request]);
      const previous = requests.get(request.requestId);
      if (previous) return previous.signature === signature ? previous.response
        : Promise.resolve(fail(request.requestId, 'Request ID was reused with different image settings.'));
      const response = run(request, resource);
      requests.set(request.requestId, { signature, response });
      void response.then(() => { if (requests.size > 128) requests.delete(requests.keys().next().value!); });
      return response;
    }
  };
}
