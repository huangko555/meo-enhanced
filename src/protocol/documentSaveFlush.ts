import { decodeRequestResult, type RequestResult } from './requestResult';

export const DOCUMENT_SAVE_FLUSH_TIMEOUT_MS = 1_000;

export type FlushDocumentEditsRequest = {
  readonly type: 'flushDocumentEdits';
  readonly requestId: string;
};

export type FlushDocumentEditsValue = {
  readonly text: string;
};

export type FlushDocumentEditsResolution = RequestResult<FlushDocumentEditsValue>;

export type FlushDocumentEditsResponse = {
  readonly type: 'flushDocumentEditsResult';
  readonly requestId: string;
  readonly result: FlushDocumentEditsResolution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function decodeFlushDocumentEditsRequest(value: unknown): FlushDocumentEditsRequest | null {
  return isRecord(value)
    && value.type === 'flushDocumentEdits'
    && isNonEmptyString(value.requestId)
    ? { type: 'flushDocumentEdits', requestId: value.requestId }
    : null;
}

export function decodeFlushDocumentEditsResponse(value: unknown): FlushDocumentEditsResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): FlushDocumentEditsValue | null => (
        isRecord(candidate) && typeof candidate.text === 'string'
          ? { text: candidate.text }
          : null
      ))
    : null;
  return isRecord(value)
    && value.type === 'flushDocumentEditsResult'
    && isNonEmptyString(value.requestId)
    && result !== null
    ? { type: 'flushDocumentEditsResult', requestId: value.requestId, result }
    : null;
}
