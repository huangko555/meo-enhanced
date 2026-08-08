import { decodeRequestResult, type RequestResult } from './requestResult';

export const WIKI_LINK_RESOLUTION_TIMEOUT_MS = 15_000;

export type WikiLinkStatus = {
  readonly target: string;
  readonly exists: boolean;
};

export type ResolveWikiLinksRequest = {
  readonly type: 'resolveWikiLinks';
  readonly requestId: string;
  readonly targets: string[];
};

export type WikiLinkResolutionResult = RequestResult<{ readonly results: WikiLinkStatus[] }>;

export type ResolvedWikiLinksResponse = {
  readonly type: 'resolvedWikiLinks';
  readonly requestId: string;
  readonly result: WikiLinkResolutionResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isWikiLinkStatus(value: unknown): value is WikiLinkStatus {
  return isRecord(value) && isNonEmptyString(value.target) && typeof value.exists === 'boolean';
}

export function decodeResolveWikiLinksRequest(value: unknown): ResolveWikiLinksRequest | null {
  const targets = isRecord(value) ? value.targets : undefined;
  if (!isRecord(value)
    || value.type !== 'resolveWikiLinks'
    || !isNonEmptyString(value.requestId)
    || !Array.isArray(targets)
    || targets.length === 0
    || !targets.every(isNonEmptyString)) {
    return null;
  }
  return { type: 'resolveWikiLinks', requestId: value.requestId, targets: targets as string[] };
}

export function decodeResolvedWikiLinksResponse(value: unknown): ResolvedWikiLinksResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): { readonly results: WikiLinkStatus[] } | null => {
        const candidateResults = isRecord(candidate) ? candidate.results : undefined;
        return Array.isArray(candidateResults) && candidateResults.every(isWikiLinkStatus)
          ? { results: candidateResults as WikiLinkStatus[] }
          : null;
      })
    : null;
  if (!isRecord(value)
    || value.type !== 'resolvedWikiLinks'
    || !isNonEmptyString(value.requestId)
    || result === null) {
    return null;
  }
  return { type: 'resolvedWikiLinks', requestId: value.requestId, result };
}
