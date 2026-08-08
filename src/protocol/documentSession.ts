import { decodeRequestResult, type RequestResult } from './requestResult';

export const DOCUMENT_SESSION_REQUEST_TIMEOUT_MS = 15_000;

export type DocumentRevisionDto = {
  readonly version: number;
  readonly text: string;
};

export type SaveDocumentRevisionRequest = {
  readonly type: 'saveDocumentRevision';
  readonly requestId: string;
  readonly revision: DocumentRevisionDto;
};

export type DocumentRevisionRequest = {
  readonly type: 'requestDocumentRevision';
  readonly requestId: string;
};

export type DocumentRevisionValue = {
  readonly revision: DocumentRevisionDto;
};

export type DocumentRevisionResolution = RequestResult<DocumentRevisionValue>;

export type SaveDocumentRevisionResponse = {
  readonly type: 'saveDocumentRevisionResult';
  readonly requestId: string;
  readonly result: DocumentRevisionResolution;
};

export type DocumentRevisionResponse = {
  readonly type: 'documentRevisionResult';
  readonly requestId: string;
  readonly result: DocumentRevisionResolution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function decodeRevision(value: unknown): DocumentRevisionDto | null {
  if (!isRecord(value)
    || typeof value.version !== 'number'
    || !Number.isInteger(value.version)
    || value.version < 0
    || typeof value.text !== 'string') {
    return null;
  }
  return { version: value.version, text: value.text };
}

function decodeRevisionValue(value: unknown): DocumentRevisionValue | null {
  if (!isRecord(value)) return null;
  const revision = decodeRevision(value.revision);
  return revision === null ? null : { revision };
}

export function decodeSaveDocumentRevisionRequest(value: unknown): SaveDocumentRevisionRequest | null {
  if (!isRecord(value) || value.type !== 'saveDocumentRevision' || !isNonEmptyString(value.requestId)) {
    return null;
  }
  const revision = decodeRevision(value.revision);
  return revision === null ? null : { type: 'saveDocumentRevision', requestId: value.requestId, revision };
}

export function decodeDocumentRevisionRequest(value: unknown): DocumentRevisionRequest | null {
  return isRecord(value) && value.type === 'requestDocumentRevision' && isNonEmptyString(value.requestId)
    ? { type: 'requestDocumentRevision', requestId: value.requestId }
    : null;
}

export function decodeSaveDocumentRevisionResponse(value: unknown): SaveDocumentRevisionResponse | null {
  const result = isRecord(value) ? decodeRequestResult(value.result, decodeRevisionValue) : null;
  return isRecord(value)
    && value.type === 'saveDocumentRevisionResult'
    && isNonEmptyString(value.requestId)
    && result !== null
    ? { type: 'saveDocumentRevisionResult', requestId: value.requestId, result }
    : null;
}

export function decodeDocumentRevisionResponse(value: unknown): DocumentRevisionResponse | null {
  const result = isRecord(value) ? decodeRequestResult(value.result, decodeRevisionValue) : null;
  return isRecord(value)
    && value.type === 'documentRevisionResult'
    && isNonEmptyString(value.requestId)
    && result !== null
    ? { type: 'documentRevisionResult', requestId: value.requestId, result }
    : null;
}
