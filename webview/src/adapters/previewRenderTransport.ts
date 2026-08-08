import {
  PREVIEW_RENDER_TIMEOUT_MS,
  type PreviewRenderRequest,
  type PreviewRenderResolution,
  type PreviewRenderResponse,
  type PreviewStyleEnvironment
} from '../../../src/protocol/previewRender';

type PendingRequest = {
  resolve: (result: PreviewRenderResolution) => void;
  timeout: unknown;
};

export type PreviewRenderTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type PreviewRenderTransport = {
  render(request: { readonly text: string; readonly environment?: PreviewStyleEnvironment }): Promise<PreviewRenderResolution>;
  accept(response: PreviewRenderResponse): boolean;
};

export function createPreviewRenderTransport(
  postMessage: (message: PreviewRenderRequest) => void,
  options: PreviewRenderTransportOptions = {}
): PreviewRenderTransport {
  const timeoutMs = options.timeoutMs ?? PREVIEW_RENDER_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  return {
    render(request) {
      const requestId = `preview-${Date.now()}-${requestCounter++}`;
      return new Promise((resolve) => {
        const timeout = scheduleTimeout(() => {
          if (!pending.delete(requestId)) return;
          resolve({
            ok: false,
            error: { code: 'timeout', message: 'Timed out while rendering Preview' }
          });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
        try {
          postMessage({ type: 'requestPreviewRender', requestId, ...request });
        } catch (error) {
          const pendingRequest = pending.get(requestId);
          if (!pendingRequest) return;
          pending.delete(requestId);
          cancelTimeout(pendingRequest.timeout);
          resolve({
            ok: false,
            error: {
              code: 'operation-failed',
              message: error instanceof Error ? error.message : 'Failed to send Preview render request'
            }
          });
        }
      });
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
