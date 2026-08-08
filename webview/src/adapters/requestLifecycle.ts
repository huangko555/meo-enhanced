import type { ProtocolErrorCode, RequestResult } from '../../../src/protocol/requestResult';

export type RequestLifecycleOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type RequestLifecycle<T> = {
  start(
    send: (requestId: string) => void,
    messages: { readonly timeout: string; readonly sendFailed: string }
  ): Promise<RequestResult<T>>;
  accept(requestId: string, result: RequestResult<T>): boolean;
  cancelAll(message: string): void;
};

type PendingRequest<T> = {
  readonly resolve: (result: RequestResult<T>) => void;
  readonly timeout: unknown;
};

export function createRequestLifecycle<T>(
  requestIdPrefix: string,
  defaultTimeoutMs: number,
  options: RequestLifecycleOptions = {}
): RequestLifecycle<T> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const scheduleTimeout = options.scheduleTimeout
    ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout
    ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest<T>>();
  let requestCounter = 0;

  const errorResult = (code: ProtocolErrorCode, message: string): RequestResult<T> => ({
    ok: false,
    error: { code, message }
  });

  const settle = (requestId: string, result: RequestResult<T>): boolean => {
    const request = pending.get(requestId);
    if (!request) return false;
    pending.delete(requestId);
    cancelTimeout(request.timeout);
    request.resolve(result);
    return true;
  };

  return {
    start(send, messages) {
      const requestId = `${requestIdPrefix}-${requestCounter++}`;
      return new Promise((resolve) => {
        const timeout = scheduleTimeout(() => {
          settle(requestId, errorResult('timeout', messages.timeout));
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
        try {
          send(requestId);
        } catch (error) {
          settle(requestId, errorResult(
            'operation-failed',
            error instanceof Error ? error.message : messages.sendFailed
          ));
        }
      });
    },
    accept: settle,
    cancelAll(message) {
      for (const requestId of Array.from(pending.keys())) {
        settle(requestId, errorResult('operation-failed', message));
      }
    }
  };
}
