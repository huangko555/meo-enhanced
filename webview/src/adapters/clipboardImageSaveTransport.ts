import {
  CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS,
  type ClipboardImageSaveResult,
  type SaveImageFromClipboardRequest,
  type SavedImagePathResponse
} from '../../../src/protocol/clipboardImageSave';

type PendingRequest = {
  resolve: (result: ClipboardImageSaveResult) => void;
  timeout: unknown;
};

export type ClipboardImageSaveTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type ClipboardImageSaveTransport = {
  save(request: Omit<SaveImageFromClipboardRequest, 'type' | 'requestId'>): Promise<ClipboardImageSaveResult>;
  accept(response: SavedImagePathResponse): boolean;
};

export function createClipboardImageSaveTransport(
  postMessage: (message: SaveImageFromClipboardRequest) => void,
  options: ClipboardImageSaveTransportOptions = {}
): ClipboardImageSaveTransport {
  const timeoutMs = options.timeoutMs ?? CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  return {
    save(request) {
      const requestId = `img-save-${requestCounter++}`;
      const result = new Promise<ClipboardImageSaveResult>((resolve) => {
        const timeout = scheduleTimeout(() => {
          pending.delete(requestId);
          resolve({
            ok: false,
            error: { code: 'timeout', message: 'Timed out while saving pasted image' }
          });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
      });
      try {
        postMessage({ type: 'saveImageFromClipboard', requestId, ...request });
      } catch (error) {
        const pendingRequest = pending.get(requestId);
        if (pendingRequest) {
          pending.delete(requestId);
          cancelTimeout(pendingRequest.timeout);
          pendingRequest.resolve({
            ok: false,
            error: {
              code: 'operation-failed',
              message: error instanceof Error ? error.message : 'Failed to send image save request'
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
