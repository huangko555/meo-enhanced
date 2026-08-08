import {
  LOCAL_LINK_RESOLUTION_TIMEOUT_MS,
  type LocalLinkResolutionResult,
  type ResolveLocalLinksRequest,
  type ResolvedLocalLinksResponse
} from '../../../src/protocol/localLinkResolution';

type PendingRequest = {
  resolve: (result: LocalLinkResolutionResult) => void;
  timeout: unknown;
};

export type LocalLinkResolutionTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type LocalLinkResolutionTransport = {
  resolve(targets: string[]): Promise<LocalLinkResolutionResult>;
  accept(response: ResolvedLocalLinksResponse): boolean;
};

export function createLocalLinkResolutionTransport(
  postMessage: (message: ResolveLocalLinksRequest) => void,
  options: LocalLinkResolutionTransportOptions = {}
): LocalLinkResolutionTransport {
  const timeoutMs = options.timeoutMs ?? LOCAL_LINK_RESOLUTION_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  return {
    resolve(targets) {
      const requestId = `local-link-${requestCounter++}`;
      const result = new Promise<LocalLinkResolutionResult>((resolve) => {
        const timeout = scheduleTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, error: { code: 'timeout', message: 'Timed out while resolving local links' } });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
      });
      try {
        postMessage({ type: 'resolveLocalLinks', requestId, targets });
      } catch (error) {
        const pendingRequest = pending.get(requestId);
        if (pendingRequest) {
          pending.delete(requestId);
          cancelTimeout(pendingRequest.timeout);
          pendingRequest.resolve({
            ok: false,
            error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Failed to send local links request' }
          });
        }
      }
      return result;
    },
    accept(response) {
      const pendingRequest = pending.get(response.requestId);
      if (!pendingRequest) return false;
      pending.delete(response.requestId);
      cancelTimeout(pendingRequest.timeout);
      pendingRequest.resolve(response.result);
      return true;
    }
  };
}
