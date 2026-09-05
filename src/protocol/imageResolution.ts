import { decodeRequestResult, type RequestResult } from './requestResult';

export const IMAGE_RESOLUTION_TIMEOUT_MS = 15_000;

export type ResolveImageSrcRequest = {
  readonly type: 'resolveImageSrc';
  readonly requestId: string;
  readonly url: string;
  readonly delivery?: 'embedded';
};

export type ResolvedImageSrc = {
  readonly resolvedUrl: string;
};

export type ImageResolutionResult = RequestResult<ResolvedImageSrc>;

export type ResolvedImageSrcResponse = {
  readonly type: 'resolvedImageSrc';
  readonly requestId: string;
  readonly result: ImageResolutionResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function decodeResolveImageSrcRequest(value: unknown): ResolveImageSrcRequest | null {
  if (!isRecord(value)
    || value.type !== 'resolveImageSrc'
    || !isNonEmptyString(value.requestId)
    || !isNonEmptyString(value.url)) {
    return null;
  }
  if (value.delivery !== undefined && value.delivery !== 'embedded') return null;
  return {
    type: 'resolveImageSrc',
    requestId: value.requestId,
    url: value.url,
    ...(value.delivery === 'embedded' ? { delivery: 'embedded' as const } : {})
  };
}

export function decodeResolvedImageSrcResponse(value: unknown): ResolvedImageSrcResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): ResolvedImageSrc | null => (
        isRecord(candidate) && typeof candidate.resolvedUrl === 'string'
          ? { resolvedUrl: candidate.resolvedUrl }
          : null
      ))
    : null;
  if (!isRecord(value)
    || value.type !== 'resolvedImageSrc'
    || !isNonEmptyString(value.requestId)
    || result === null) {
    return null;
  }
  return { type: 'resolvedImageSrc', requestId: value.requestId, result };
}
