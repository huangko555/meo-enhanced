import {
  IMAGE_RESOLUTION_TIMEOUT_MS,
  type ImageResolutionResult,
  type ResolveImageSrcRequest,
  type ResolvedImageSrcResponse
} from '../../../src/protocol/imageResolution';

type PendingRequest = {
  resolve: (result: ImageResolutionResult) => void;
  timeout: unknown;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type ImageResolutionTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type ImageResolutionTransport = {
  resolve(url: string, signal?: AbortSignal): Promise<ImageResolutionResult>;
  accept(response: ResolvedImageSrcResponse): boolean;
};

export function createImageResolutionTransport(
  postMessage: (message: ResolveImageSrcRequest) => void,
  options: ImageResolutionTransportOptions = {}
): ImageResolutionTransport {
  const timeoutMs = options.timeoutMs ?? IMAGE_RESOLUTION_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  const settle = (requestId: string, result: ImageResolutionResult): boolean => {
    const request = pending.get(requestId);
    if (!request) return false;
    pending.delete(requestId);
    cancelTimeout(request.timeout);
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener('abort', request.onAbort);
    }
    request.resolve(result);
    return true;
  };

  return {
    resolve(url, signal) {
      const requestId = `img-${requestCounter++}`;
      const result = new Promise<ImageResolutionResult>((resolve) => {
        const timeout = scheduleTimeout(() => {
          settle(requestId, {
            ok: false,
            error: { code: 'timeout', message: 'Timed out while resolving image source' }
          });
        }, timeoutMs);
        const onAbort = () => {
          settle(requestId, {
            ok: false,
            error: { code: 'operation-failed', message: 'Image source resolution was cancelled' }
          });
        };
        pending.set(requestId, { resolve, timeout, signal, onAbort });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (signal?.aborted) return result;
      try {
        postMessage({ type: 'resolveImageSrc', requestId, url });
      } catch (error) {
        settle(requestId, {
          ok: false,
          error: {
            code: 'operation-failed',
            message: error instanceof Error ? error.message : 'Failed to send image resolution request'
          }
        });
      }
      return result;
    },
    accept(response) {
      return settle(response.requestId, response.result);
    }
  };
}
