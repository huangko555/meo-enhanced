import { decodeRequestResult, type RequestResult } from './requestResult';

export const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 15_000;

export type SaveImageFromClipboardRequest = {
  readonly type: 'saveImageFromClipboard';
  readonly requestId: string;
  readonly imageData: string;
  readonly fileName: string;
};

export type SavedImagePath = {
  readonly path: string;
};

export type ClipboardImageSaveResult = RequestResult<SavedImagePath>;

export type SavedImagePathResponse = {
  readonly type: 'savedImagePath';
  readonly requestId: string;
  readonly result: ClipboardImageSaveResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function decodeSaveImageFromClipboardRequest(value: unknown): SaveImageFromClipboardRequest | null {
  if (!isRecord(value)
    || value.type !== 'saveImageFromClipboard'
    || !isNonEmptyString(value.requestId)
    || !isNonEmptyString(value.imageData)
    || !isNonEmptyString(value.fileName)) {
    return null;
  }
  return value as SaveImageFromClipboardRequest;
}

export function decodeSavedImagePathResponse(value: unknown): SavedImagePathResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): SavedImagePath | null => (
        isRecord(candidate) && isNonEmptyString(candidate.path) ? { path: candidate.path } : null
      ))
    : null;
  if (!isRecord(value)
    || value.type !== 'savedImagePath'
    || !isNonEmptyString(value.requestId)
    || result === null) {
    return null;
  }
  return { type: 'savedImagePath', requestId: value.requestId, result };
}
