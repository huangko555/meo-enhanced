import type { ExportSnapshotResponse, ExportSnapshotResolution } from '../../../src/protocol/exportSnapshot';

export type ExportSnapshotResponder = {
  respond(requestId: string, result: ExportSnapshotResolution): void;
};

export function createExportSnapshotResponder(
  postMessage: (message: ExportSnapshotResponse) => void
): ExportSnapshotResponder {
  return {
    respond(requestId, result) {
      postMessage({ type: 'exportSnapshotResult', requestId, result });
    }
  };
}
