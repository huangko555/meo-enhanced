import { decodeRequestResult, type RequestResult } from './requestResult';

export const DOCUMENT_COPY_TIMEOUT_MS = 600_000;

export type SaveDocumentCopyRequest = {
  readonly type: 'saveDocumentCopy';
  readonly requestId: string;
  readonly text: string;
};

export type DocumentCopyOutcome = { readonly status: 'saved' | 'cancelled' };
export type DocumentCopyResult = RequestResult<DocumentCopyOutcome>;

export type DocumentCopyResponse = {
  readonly type: 'documentCopyResult';
  readonly requestId: string;
  readonly result: DocumentCopyResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function decodeSaveDocumentCopyRequest(value: unknown): SaveDocumentCopyRequest | null {
  return isRecord(value)
    && value.type === 'saveDocumentCopy'
    && typeof value.requestId === 'string'
    && value.requestId.length > 0
    && typeof value.text === 'string'
    ? { type: 'saveDocumentCopy', requestId: value.requestId, text: value.text }
    : null;
}

export function decodeDocumentCopyResponse(value: unknown): DocumentCopyResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): DocumentCopyOutcome | null => (
        isRecord(candidate) && (candidate.status === 'saved' || candidate.status === 'cancelled')
          ? { status: candidate.status }
          : null
      ))
    : null;
  return isRecord(value)
    && value.type === 'documentCopyResult'
    && typeof value.requestId === 'string'
    && value.requestId.length > 0
    && result !== null
    ? { type: 'documentCopyResult', requestId: value.requestId, result }
    : null;
}
