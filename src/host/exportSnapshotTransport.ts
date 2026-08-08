import {
  EXPORT_SNAPSHOT_TIMEOUT_MS,
  type ExportSnapshotRequest,
  type ExportSnapshotResolution,
  type ExportSnapshotResponse
} from '../protocol/exportSnapshot';

type PendingRequest = {
  resolve: (result: ExportSnapshotResolution) => void;
  timeout: unknown;
};

export type ExportSnapshotTransportOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type ExportSnapshotTransport = {
  request(): Promise<ExportSnapshotResolution>;
  accept(response: ExportSnapshotResponse): boolean;
  close(message: string): void;
};

export function createExportSnapshotTransport(
  postMessage: (message: ExportSnapshotRequest) => Promise<boolean>,
  options: ExportSnapshotTransportOptions = {}
): ExportSnapshotTransport {
  const timeoutMs = options.timeoutMs ?? EXPORT_SNAPSHOT_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const pending = new Map<string, PendingRequest>();
  let requestCounter = 0;

  const settle = (requestId: string, result: ExportSnapshotResolution): boolean => {
    const pendingRequest = pending.get(requestId);
    if (!pendingRequest) return false;
    pending.delete(requestId);
    cancelTimeout(pendingRequest.timeout);
    pendingRequest.resolve(result);
    return true;
  };

  return {
    request() {
      const requestId = `export-${Date.now()}-${requestCounter++}`;
      const response = new Promise<ExportSnapshotResolution>((resolve) => {
        const timeout = scheduleTimeout(() => {
          if (!pending.delete(requestId)) return;
          resolve({
            ok: false,
            error: { code: 'timeout', message: 'Timed out waiting for export snapshot from the editor.' }
          });
        }, timeoutMs);
        pending.set(requestId, { resolve, timeout });
      });
      void postMessage({ type: 'requestExportSnapshot', requestId }).then((posted) => {
        if (!posted) {
          settle(requestId, {
            ok: false,
            error: { code: 'operation-failed', message: 'The editor webview is not ready to export.' }
          });
        }
      }).catch((error) => {
        settle(requestId, {
          ok: false,
          error: {
            code: 'operation-failed',
            message: error instanceof Error ? error.message : 'Failed to request export snapshot.'
          }
        });
      });
      return response;
    },
    accept(response) {
      return settle(response.requestId, response.result);
    },
    close(message) {
      for (const requestId of Array.from(pending.keys())) {
        settle(requestId, { ok: false, error: { code: 'operation-failed', message } });
      }
    }
  };
}
