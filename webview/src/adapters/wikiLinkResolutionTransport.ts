import {
  WIKI_LINK_RESOLUTION_TIMEOUT_MS,
  type ResolveWikiLinksRequest,
  type ResolvedWikiLinksResponse,
  type WikiLinkResolutionResult
} from '../../../src/protocol/wikiLinkResolution';

type PendingRequest = {
  resolve: (result: WikiLinkResolutionResult) => void;
  timeout: unknown;
};

export type WikiLinkResolutionTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type WikiLinkResolutionTransport = {
  resolve(targets: string[]): Promise<WikiLinkResolutionResult>;
  accept(response: ResolvedWikiLinksResponse): boolean;
};

export function createWikiLinkResolutionTransport(
  postMessage: (message: ResolveWikiLinksRequest) => void,
  options: WikiLinkResolutionTransportOptions = {}
): WikiLinkResolutionTransport {
  const timeoutMs = options.timeoutMs ?? WIKI_LINK_RESOLUTION_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  return {
    resolve(targets) {
      const requestId = `wiki-${requestCounter++}`;
      const result = new Promise<WikiLinkResolutionResult>((resolve) => {
        const timeout = scheduleTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, error: { code: 'timeout', message: 'Timed out while resolving Wiki Links' } });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
      });
      try {
        postMessage({ type: 'resolveWikiLinks', requestId, targets });
      } catch (error) {
        const pendingRequest = pending.get(requestId);
        if (pendingRequest) {
          pending.delete(requestId);
          cancelTimeout(pendingRequest.timeout);
          pendingRequest.resolve({
            ok: false,
            error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Failed to send Wiki Links request' }
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
