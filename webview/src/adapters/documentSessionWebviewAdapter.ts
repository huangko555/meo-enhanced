import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/protocol/messages';
import type { DocumentPresentationSource, DocumentSessionInput } from '../../../src/application/documentSession';
import type { DocumentReloadedFromDiskMessage } from '../../../src/protocol/documentSync';
import type { InitMessage } from '../../../src/protocol/readyInit';
import { createDocumentSessionRuntime } from './documentSessionRuntime';
import { createDocumentSessionTransport } from './documentSessionTransport';
import type { DocumentSessionNotice } from './documentSessionActions';
import type { DocumentText, DocumentTextEdit } from '../../../src/foundation/documentSnapshot';

export type DocumentSessionViewPosition = {
  readonly topLine: number;
  readonly topLineOffset: number;
};

export type DocumentSessionWebviewAdapter = {
  readCurrentText(): DocumentText | null;
  start(message: InitMessage): void;
  accept(message: HostToWebviewMessage): boolean;
  localDraftChanged(change: string | DocumentTextEdit): void;
  requestSave(): void;
  requestReloadFromDisk(position: DocumentSessionViewPosition): void;
  retryPresentation(): Promise<boolean>;
  whenIdle(): Promise<void>;
  dispose(): void;
};

export type DocumentSessionWebviewAdapterDependencies = {
  /** Fixed for one iframe evaluation; all recovery traffic is page-scoped. */
  readonly pageId: string;
  readonly postMessage: (message: WebviewToHostMessage) => void;
  readonly presentText: (
    text: string,
    source: DocumentPresentationSource
  ) => boolean | void | Promise<boolean | void>;
  readonly restoreReloadedView: (message: DocumentReloadedFromDiskMessage) => void;
  readonly showNotice: (notice: DocumentSessionNotice) => void;
  readonly reportUnexpectedError: (context: string, error: unknown) => void;
};

/**
 * Owns the Webview lifecycle seam for one Document Session. Callers supply
 * concrete UI capabilities; coordinator, Transport and ordering stay private.
 */
export function createDocumentSessionWebviewAdapter(
  dependencies: DocumentSessionWebviewAdapterDependencies
): DocumentSessionWebviewAdapter {
  const transport = createDocumentSessionTransport(dependencies.postMessage);
  const runtime = createDocumentSessionRuntime({
    pageId: dependencies.pageId,
    postMessage: dependencies.postMessage,
    presentText: dependencies.presentText,
    executeRemote: (action) => transport.execute(action),
    showNotice: dependencies.showNotice
  });
  let operation: Promise<void> = Promise.resolve();
  let started = false;
  let ready = false;
  let disposed = false;
  // These are input receipts, not another document model.  The runtime is the
  // only owner of document state. Keeping the not-yet-accepted receipts lets
  // unload synchronously apply them in their arrival order when a remote
  // operation is currently holding the normal queue.
  type PendingSessionInput = {
    readonly input: DocumentSessionInput;
    accepted: boolean;
  };
  type PendingSessionOperation = {
    readonly inputs: readonly PendingSessionInput[];
  };
  const pendingSessionOperations: PendingSessionOperation[] = [];

  const enqueue = (context: string, task: () => Promise<unknown> | void): Promise<void> => {
    if (disposed) return Promise.resolve();
    operation = operation
      .then(async () => { await task(); })
      .catch((error) => dependencies.reportUnexpectedError(context, error));
    return operation;
  };

  const enqueueSession = (
    context: string,
    inputs: readonly DocumentSessionInput[],
    task: (receipts: readonly PendingSessionInput[]) => Promise<unknown> | void
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    // Inputs received before start are rejected by the normal queue and must
    // not be resurrected into close recovery after a later initialization.
    // Inputs queued after start but before its Init task settles are valid:
    // their queue position is already after Init.
    const admitted = started;
    const pending = admitted ? { inputs: inputs.map(input => ({ input, accepted: false })) } : null;
    if (pending) pendingSessionOperations.push(pending);
    return enqueue(context, async () => {
      if (disposed) return;
      if (!admitted || !ready) throw new Error('Document Session received input before Init');
      try { await task(pending?.inputs ?? []); }
      finally {
        if (pending) {
          const index = pendingSessionOperations.indexOf(pending);
          if (index >= 0) pendingSessionOperations.splice(index, 1);
        }
      }
    });
  };

  const acceptSessionMessage = (message: HostToWebviewMessage): boolean => {
    if (message.type === 'requestDraftRecoverySnapshot') {
      if (message.pageId !== dependencies.pageId) return true;
      enqueueSession('draft recovery resync', [], () => runtime.resendDraftRecovery());
      return true;
    }
    if (message.type === 'saveDocumentRevisionResult' || message.type === 'documentRevisionResult') {
      transport.accept(message);
      return true;
    }
    if (message.type === 'docChanged') {
      const input = {
        type: 'hostRevisionChanged',
        version: message.version,
        text: message.text
      } as const;
      enqueueSession('Host Revision', [input], receipts => runtime.handle(input, () => {
        receipts[0]!.accepted = true;
      }));
      return true;
    }
    if (message.type === 'applied') {
      const input = {
        type: 'hostChangeApplied',
        version: message.version
      } as const;
      enqueueSession('accepted Change', [input], receipts => runtime.handle(input, () => {
        receipts[0]!.accepted = true;
      }));
      return true;
    }
    if (message.type === 'documentReloadedFromDisk') {
      enqueueSession('document reload', [], async () => {
        const completions = await runtime.handle({
          type: 'hostReloadedFromDisk',
          version: message.version,
          text: message.text
        });
        const accepted = completions.includes('discard-draft-recovery');
        enqueueSession('document reload completion', [], () => {
          dependencies.postMessage({
            type: 'documentReloadPresentationCompleted',
            reloadId: message.reloadId,
            presented: accepted,
            receiptVersion: runtime.draftRecoveryReceiptVersion()
          });
          if (accepted) dependencies.restoreReloadedView(message);
        });
      });
      return true;
    }
    if (message.type === 'documentReloadFromDiskFailed') {
      enqueueSession('document reload failure', [], () => {
        dependencies.reportUnexpectedError('document reload failure', new Error(message.message));
        dependencies.showNotice('reload-from-disk-failed');
      });
      return true;
    }
    return false;
  };

  return {
    readCurrentText: () => disposed ? null : runtime.currentText(),
    start(message) {
      if (started || disposed) return;
      if (message.pageId !== dependencies.pageId) return;
      started = true;
      // Init owns the session immediately. This makes start -> local -> close
      // in one stack a defined ordered handoff rather than an uninitialized
      // queue whose final input cannot be folded during unload.
      void runtime.initialize(message);
      ready = true;
    },
    accept(message) {
      return acceptSessionMessage(message);
    },
    localDraftChanged(change) {
      if (disposed) return;
      const input = typeof change === 'string'
        ? { type: 'localDraftChanged' as const, text: change }
        : { type: 'localDraftChanged' as const, text: change.after, edit: change };
      enqueueSession('local draft', [input, { type: 'submitPendingDraft' }], async receipts => {
        const changed = runtime.handle(input, () => { receipts[0]!.accepted = true; });
        const submitted = runtime.handle({ type: 'submitPendingDraft' }, () => { receipts[1]!.accepted = true; });
        await Promise.all([changed, submitted]);
      });
    },
    requestSave() {
      const input = { type: 'saveRequested' } as const;
      enqueueSession('save', [input], receipts => runtime.handle(input, () => {
        receipts[0]!.accepted = true;
      }));
    },
    requestReloadFromDisk(position) {
      enqueueSession('document reload request', [], async () => {
        await runtime.whenIdle();
        if (disposed) return;
        dependencies.postMessage({
          type: 'reloadDocumentFromDisk',
          topLine: position.topLine,
          topLineOffset: position.topLineOffset
        });
      });
    },
    async retryPresentation() {
      let succeeded = false;
      enqueueSession('presentation retry', [], async () => {
        succeeded = await runtime.retryPresentation();
      });
      await operation;
      return succeeded;
    },
    async whenIdle() {
      let pending: Promise<void>;
      do {
        pending = operation;
        await pending;
      } while (pending !== operation);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const pendingInputs = pendingSessionOperations
        .flatMap(pending => pending.inputs)
        .filter(receipt => !receipt.accepted)
        .map(receipt => receipt.input);
      try { runtime.dispose(pendingInputs); }
      finally {
        pendingSessionOperations.length = 0;
        transport.cancelAll('Document Session closed');
      }
    }
  };
}
