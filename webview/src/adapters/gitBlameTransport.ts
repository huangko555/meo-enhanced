import {
  GIT_BLAME_TIMEOUT_MS,
  type GitBlameRequest,
  type GitBlameResolution,
  type GitBlameResponse
} from '../../../src/protocol/git';

type PendingRequest = {
  resolve: (result: GitBlameResolution) => void;
  timeout: unknown;
};

export type GitBlameTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type GitBlameTransport = {
  request(request: Omit<GitBlameRequest, 'type' | 'requestId'>): Promise<GitBlameResolution>;
  accept(response: GitBlameResponse): boolean;
  cancelAll(message?: string): void;
};

export function createGitBlameTransport(
  postMessage: (message: GitBlameRequest) => void,
  options: GitBlameTransportOptions = {}
): GitBlameTransport {
  const timeoutMs = options.timeoutMs ?? GIT_BLAME_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  const settle = (requestId: string, result: GitBlameResolution): boolean => {
    const pendingRequest = pending.get(requestId);
    if (!pendingRequest) return false;
    pending.delete(requestId);
    cancelTimeout(pendingRequest.timeout);
    pendingRequest.resolve(result);
    return true;
  };

  return {
    request(request) {
      const requestId = `blame-${requestCounter++}`;
      return new Promise((resolve) => {
        const timeout = scheduleTimeout(() => {
          if (!pending.delete(requestId)) return;
          resolve({ ok: false, error: { code: 'timeout', message: 'Timed out while resolving Git blame' } });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
        try {
          postMessage({ type: 'requestGitBlame', requestId, ...request });
        } catch (error) {
          settle(requestId, {
            ok: false,
            error: {
              code: 'operation-failed',
              message: error instanceof Error ? error.message : 'Failed to send Git blame request'
            }
          });
        }
      });
    },
    accept(response) {
      return settle(response.requestId, response.result);
    },
    cancelAll(message = 'Git blame request superseded') {
      for (const requestId of Array.from(pending.keys())) {
        settle(requestId, { ok: false, error: { code: 'operation-failed', message } });
      }
    }
  };
}
