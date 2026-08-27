import type { EditorStyleEnvironment } from '../../../src/protocol/editorStyleEnvironment';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/protocol/messages';
import type { PreviewAppearance } from '../../../src/protocol/previewRender';
import type { ExportSnapshotResolution } from '../../../src/protocol/exportSnapshot';
import { createExportSnapshotResponder } from './exportSnapshotTransport';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';

export type ExportWebviewAdapterDependencies = {
  readonly postMessage: (message: WebviewToHostMessage) => void;
  readonly getCurrentText: () => string;
  readonly whenDocumentIdle: () => Promise<void>;
  readonly getPreviewAppearance: () => PreviewAppearance;
  readonly getUiLanguage: () => UiLanguage;
  readonly getStyleEnvironment: () => EditorStyleEnvironment;
};

export type ExportWebviewAdapter = {
  requestExport(format: 'html' | 'pdf'): void;
  accept(message: HostToWebviewMessage): boolean;
  dispose(): void;
};

const closedResult = (): ExportSnapshotResolution => ({
  ok: false,
  error: {
    code: 'operation-failed',
    message: 'The editor was closed before export completed.'
  }
});

/** Owns Export command and snapshot collection ordering for one Webview lifecycle. */
export function createExportWebviewAdapter(
  dependencies: ExportWebviewAdapterDependencies
): ExportWebviewAdapter {
  const responder = createExportSnapshotResponder(dependencies.postMessage);
  const pendingSnapshots = new Set<string>();
  const seenRequestIds = new Set<string>();
  let disposed = false;

  const settle = (requestId: string, result: ExportSnapshotResolution): void => {
    if (!pendingSnapshots.delete(requestId)) return;
    responder.respond(requestId, result);
  };

  const getIdleBarrier = (): Promise<void> => {
    try {
      return dependencies.whenDocumentIdle();
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const handleSnapshotRequest = (requestId: string): void => {
    if (seenRequestIds.has(requestId)) return;
    seenRequestIds.add(requestId);
    if (disposed) {
      responder.respond(requestId, closedResult());
      return;
    }

    pendingSnapshots.add(requestId);
    void getIdleBarrier().then(
      () => {
        if (!pendingSnapshots.has(requestId) || disposed) return;
        try {
          const environment = structuredClone(dependencies.getStyleEnvironment());
          settle(requestId, {
            ok: true,
            value: Object.freeze({
              snapshotId: requestId,
              text: dependencies.getCurrentText(),
              appearance: dependencies.getPreviewAppearance(),
              uiLanguage: dependencies.getUiLanguage(),
              environment: Object.freeze(environment)
            })
          });
        } catch (error) {
          settle(requestId, {
            ok: false,
            error: {
              code: 'operation-failed',
              message: error instanceof Error ? error.message : 'Failed to collect export snapshot'
            }
          });
        }
      },
      (error) => {
        settle(requestId, {
          ok: false,
          error: {
            code: 'operation-failed',
            message: error instanceof Error ? error.message : 'Failed to collect export snapshot'
          }
        });
      }
    );
  };

  return {
    requestExport(format) {
      if (disposed) return;
      dependencies.postMessage({
        type: 'exportDocument',
        format
      });
    },
    accept(message) {
      if (message.type !== 'requestExportSnapshot') return false;
      handleSnapshotRequest(message.requestId);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const requestId of Array.from(pendingSnapshots)) {
        settle(requestId, closedResult());
      }
    }
  };
}
