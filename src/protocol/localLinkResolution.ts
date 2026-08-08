import { decodeRequestResult, type RequestResult } from './requestResult';

export const LOCAL_LINK_RESOLUTION_TIMEOUT_MS = 15_000;

export type LocalLinkStatus = {
  readonly target: string;
  readonly exists: boolean;
};

export type ResolveLocalLinksRequest = {
  readonly type: 'resolveLocalLinks';
  readonly requestId: string;
  readonly targets: string[];
};

export type LocalLinkResolutionResult = RequestResult<{ readonly results: LocalLinkStatus[] }>;

export type ResolvedLocalLinksResponse = {
  readonly type: 'resolvedLocalLinks';
  readonly requestId: string;
  readonly result: LocalLinkResolutionResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLocalLinkStatus(value: unknown): value is LocalLinkStatus {
  return isRecord(value) && isNonEmptyString(value.target) && typeof value.exists === 'boolean';
}

export function decodeResolveLocalLinksRequest(value: unknown): ResolveLocalLinksRequest | null {
  const targets = isRecord(value) ? value.targets : undefined;
  if (!isRecord(value)
    || value.type !== 'resolveLocalLinks'
    || !isNonEmptyString(value.requestId)
    || !Array.isArray(targets)
    || targets.length === 0
    || !targets.every(isNonEmptyString)) {
    return null;
  }
  return { type: 'resolveLocalLinks', requestId: value.requestId, targets: targets as string[] };
}

export function decodeResolvedLocalLinksResponse(value: unknown): ResolvedLocalLinksResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): { readonly results: LocalLinkStatus[] } | null => {
        const candidateResults = isRecord(candidate) ? candidate.results : undefined;
        return Array.isArray(candidateResults) && candidateResults.every(isLocalLinkStatus)
          ? { results: candidateResults as LocalLinkStatus[] }
          : null;
      })
    : null;
  if (!isRecord(value)
    || value.type !== 'resolvedLocalLinks'
    || !isNonEmptyString(value.requestId)
    || result === null) {
    return null;
  }
  return { type: 'resolvedLocalLinks', requestId: value.requestId, result };
}
