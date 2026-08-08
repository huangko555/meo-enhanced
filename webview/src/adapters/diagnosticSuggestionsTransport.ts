import {
  DIAGNOSTIC_SUGGESTIONS_TIMEOUT_MS,
  type DiagnosticSuggestionsResult,
  type RequestDiagnosticSuggestions
} from '../../../src/protocol/diagnosticSuggestions';

type PendingRequest = {
  from: number;
  to: number;
  timeout: unknown;
};

export type DiagnosticSuggestionsTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type DiagnosticSuggestionsTransport = {
  request(request: Omit<RequestDiagnosticSuggestions, 'type' | 'requestId'>): string;
  accept(response: DiagnosticSuggestionsResult): boolean;
  cancelAll(): void;
};

export function createDiagnosticSuggestionsTransport(
  postMessage: (message: RequestDiagnosticSuggestions) => void,
  onResult: (response: DiagnosticSuggestionsResult) => void,
  options: DiagnosticSuggestionsTransportOptions = {}
): DiagnosticSuggestionsTransport {
  const timeoutMs = options.timeoutMs ?? DIAGNOSTIC_SUGGESTIONS_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  const cancelAll = (): void => {
    for (const pendingRequest of pending.values()) {
      cancelTimeout(pendingRequest.timeout);
    }
    pending.clear();
  };

  return {
    request(request) {
      cancelAll();
      const requestId = `diagnostic-suggestions-${Date.now()}-${requestCounter++}`;
      const timeout = scheduleTimeout(() => {
        const pendingRequest = pending.get(requestId);
        if (!pendingRequest) return;
        pending.delete(requestId);
        onResult({
          type: 'diagnosticSuggestionsResult',
          requestId,
          from: pendingRequest.from,
          to: pendingRequest.to,
          result: { ok: false, error: { code: 'timeout', message: 'Timed out while resolving diagnostic suggestions' } }
        });
      }, timeoutMs);
      pending.set(requestId, { from: request.from, to: request.to, timeout });
      try {
        postMessage({ type: 'requestDiagnosticSuggestions', requestId, ...request });
      } catch (error) {
        const pendingRequest = pending.get(requestId);
        if (pendingRequest) {
          pending.delete(requestId);
          cancelTimeout(pendingRequest.timeout);
          onResult({
            type: 'diagnosticSuggestionsResult',
            requestId,
            from: pendingRequest.from,
            to: pendingRequest.to,
            result: {
              ok: false,
              error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Failed to send diagnostic suggestions request' }
            }
          });
        }
      }
      return requestId;
    },
    accept(response) {
      const pendingRequest = pending.get(response.requestId);
      if (!pendingRequest) return false;
      pending.delete(response.requestId);
      cancelTimeout(pendingRequest.timeout);
      onResult(response);
      return true;
    },
    cancelAll
  };
}
