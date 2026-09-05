import * as vscode from 'vscode';
import {
  DOCUMENT_SAVE_FLUSH_TIMEOUT_MS,
  type FlushDocumentEditsRequest,
  type FlushDocumentEditsResolution,
  type FlushDocumentEditsResponse
} from '../protocol/documentSaveFlush';

type PendingFlush = {
  readonly requestId: string;
  readonly documentVersion: number;
  readonly refreshed: boolean;
  readonly resolve: (result: FlushDocumentEditsResolution) => void;
  readonly timeout: unknown;
};

export type VscodeDocumentSaveLifecycleAdapterOptions = {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (timeout: unknown) => void;
};

export type VscodeDocumentSaveLifecycleAdapter = {
  accept(response: FlushDocumentEditsResponse): boolean;
  runPreparedSave<Result>(save: () => Promise<Result>): Promise<Result>;
  dispose(): void;
};

export type VscodeDocumentSaveLifecycleAdapterDependencies = {
  readonly document: vscode.TextDocument;
  readonly postMessage: (message: FlushDocumentEditsRequest) => Promise<boolean>;
  readonly showFailure: (message: string) => void;
};

const normalize = (text: string): string => text.replace(/\r\n/g, '\n');

const failure = (code: 'timeout' | 'operation-failed', message: string): FlushDocumentEditsResolution => ({
  ok: false,
  error: { code, message }
});

/**
 * Adapts VS Code's bounded will-save participant to a correlated Webview flush.
 * One refresh may follow a concurrent document change, within the same budget.
 * A failed participant is observable but cannot cancel VS Code's native save.
 */
export function createVscodeDocumentSaveLifecycleAdapter(
  dependencies: VscodeDocumentSaveLifecycleAdapterDependencies,
  options: VscodeDocumentSaveLifecycleAdapterOptions = {}
): VscodeDocumentSaveLifecycleAdapter {
  const timeoutMs = options.timeoutMs ?? DOCUMENT_SAVE_FLUSH_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout
    ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout
    ?? ((timeout) => globalThis.clearTimeout(timeout as ReturnType<typeof setTimeout>));
  const documentKey = dependencies.document.uri.toString();
  let nextRequestId = 0;
  let pending: PendingFlush | null = null;
  let activePreparation: Promise<void> | null = null;
  let preparedWillSaveCorrelation: object | null = null;
  let disposed = false;

  const settle = (requestId: string, result: FlushDocumentEditsResolution): boolean => {
    if (pending?.requestId !== requestId) return false;
    const current = pending;
    pending = null;
    cancelTimeout(current.timeout);
    current.resolve(result);
    return true;
  };

  const postFlush = (requestId: string): void => {
    void dependencies.postMessage({ type: 'flushDocumentEdits', requestId }).then((posted) => {
      if (!posted) {
        settle(requestId, failure(
          'operation-failed',
          'The editor Webview was unavailable while preparing the document save.'
        ));
      }
    }).catch((error) => {
      settle(requestId, failure(
        'operation-failed',
        error instanceof Error ? error.message : 'Failed to request pending editor changes.'
      ));
    });
  };

  const startPreparation = (): Promise<void> => {
    if (activePreparation) return activePreparation;
    const requestId = `document-save-flush-${nextRequestId++}`;
    const result = new Promise<FlushDocumentEditsResolution>((resolve) => {
      const timeout = scheduleTimeout(() => {
        if (pending?.resolve !== resolve) return;
        settle(pending.requestId, failure(
          'timeout',
          'Timed out while collecting pending editor changes before save.'
        ));
      }, timeoutMs);
      pending = {
        requestId, resolve, timeout,
        documentVersion: dependencies.document.version,
        refreshed: false
      };
    });
    postFlush(requestId);

    const preparation = result.then((resolution) => {
      if (resolution.ok === false) {
        dependencies.showFailure(
          `${resolution.error.message} VS Code may save without those pending changes; they remain unconfirmed.`
        );
      }
    }).finally(() => {
      if (activePreparation === preparation) activePreparation = null;
    });
    activePreparation = preparation;
    return preparation;
  };

  const willSaveSubscription = vscode.workspace.onWillSaveTextDocument((event) => {
    if (disposed || event.document.uri.toString() !== documentKey) return;
    if (preparedWillSaveCorrelation !== null
      && event.reason === vscode.TextDocumentSaveReason.Manual) {
      preparedWillSaveCorrelation = null;
      return;
    }
    // waitUntil must be registered synchronously during event dispatch.
    event.waitUntil(startPreparation());
  });

  return {
    accept(response) {
      if (disposed || pending?.requestId !== response.requestId) return false;
      if (response.result.ok === false) return settle(response.requestId, response.result);
      if (normalize(dependencies.document.getText()) !== normalize(response.result.value.text)) {
        // A response can trail a newer edit. Ask for fresh content rather than
        // treating a higher version as proof that the requested text was applied.
        // The new request ID avoids the Webview's completed-response cache.
        if (!pending.refreshed && dependencies.document.version > pending.documentVersion) {
          const requestId = `document-save-flush-${nextRequestId++}`;
          pending = {
            ...pending, requestId, refreshed: true,
            documentVersion: dependencies.document.version
          };
          postFlush(requestId);
          return true;
        }
        return settle(response.requestId, failure(
          'operation-failed',
          'The TextDocument did not reach the editor Revision requested for save.'
        ));
      }
      return settle(response.requestId, response.result);
    },
    async runPreparedSave(save) {
      const correlation = {};
      preparedWillSaveCorrelation = correlation;
      try {
        return await save();
      } finally {
        if (preparedWillSaveCorrelation === correlation) {
          preparedWillSaveCorrelation = null;
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      willSaveSubscription.dispose();
      if (pending) {
        settle(pending.requestId, failure(
          'operation-failed',
          'The editor closed before pending changes could be prepared for save.'
        ));
      }
    }
  };
}
