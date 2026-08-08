import { decodeRequestResult, type RequestResult } from './requestResult';

export const DIAGNOSTIC_SUGGESTIONS_TIMEOUT_MS = 15_000;

export type RequestDiagnosticSuggestions = {
  readonly type: 'requestDiagnosticSuggestions';
  readonly requestId: string;
  readonly from: number;
  readonly to: number;
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
};

export type DiagnosticSuggestionsResolution = RequestResult<{ readonly suggestions: string[] }>;

export type DiagnosticSuggestionsResult = {
  readonly type: 'diagnosticSuggestionsResult';
  readonly requestId: string;
  readonly from: number;
  readonly to: number;
  readonly result: DiagnosticSuggestionsResolution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function decodeDiagnosticSuggestionsRequest(value: unknown): RequestDiagnosticSuggestions | null {
  if (!isRecord(value)
    || value.type !== 'requestDiagnosticSuggestions'
    || !isNonEmptyString(value.requestId)
    || !isRange(value.from)
    || !isRange(value.to)
    || value.to < value.from
    || typeof value.message !== 'string'
    || (value.source !== undefined && typeof value.source !== 'string')
    || (value.code !== undefined && typeof value.code !== 'string')) {
    return null;
  }
  return value as RequestDiagnosticSuggestions;
}

export function decodeDiagnosticSuggestionsResult(value: unknown): DiagnosticSuggestionsResult | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): { readonly suggestions: string[] } | null => {
        const suggestions = isRecord(candidate) ? candidate.suggestions : undefined;
        return Array.isArray(suggestions) && suggestions.every((suggestion) => typeof suggestion === 'string')
          ? { suggestions: suggestions as string[] }
          : null;
      })
    : null;
  if (!isRecord(value)
    || value.type !== 'diagnosticSuggestionsResult'
    || !isNonEmptyString(value.requestId)
    || !isRange(value.from)
    || !isRange(value.to)
    || value.to < value.from
    || result === null) {
    return null;
  }
  return {
    type: 'diagnosticSuggestionsResult',
    requestId: value.requestId,
    from: value.from,
    to: value.to,
    result
  };
}
