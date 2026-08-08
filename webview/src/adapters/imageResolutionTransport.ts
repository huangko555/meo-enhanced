import {
  IMAGE_RESOLUTION_TIMEOUT_MS,
  type ImageResolutionResult,
  type ResolveImageSrcRequest,
  type ResolvedImageSrcResponse
} from '../../../src/protocol/imageResolution';

type PendingRequest = {
  resolve: (result: ImageResolutionResult) => void;
  timeout: unknown;
};

export type ImageResolutionTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type ImageResolutionTransport = {
  resolve(url: string): Promise<ImageResolutionResult>;
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

  return {
    resolve(url) {
      const requestId = `img-${requestCounter++}`;
      const result = new Promise<ImageResolutionResult>((resolve) => {
        const timeout = scheduleTimeout(() => {
          pending.delete(requestId);
          resolve({
            ok: false,
            error: { code: 'timeout', message: 'Timed out while resolving image source' }
          });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
      });
      try {
        postMessage({ type: 'resolveImageSrc', requestId, url });
      } catch (error) {
        const pendingRequest = pending.get(requestId);
        if (pendingRequest) {
          pending.delete(requestId);
          cancelTimeout(pendingRequest.timeout);
          pendingRequest.resolve({
            ok: false,
            error: {
              code: 'operation-failed',
              message: error instanceof Error ? error.message : 'Failed to send image resolution request'
            }
          });
        }
      }
      return result;
    },
    accept(response) {
      const request = pending.get(response.requestId);
      if (!request) {
        return false;
      }
      pending.delete(response.requestId);
      cancelTimeout(request.timeout);
      request.resolve(response.result);
      return true;
    }
  };
}
