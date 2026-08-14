import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/protocol/messages';
import type { DocumentReloadedFromDiskMessage } from '../../../src/protocol/documentSync';
import type { InitMessage } from '../../../src/protocol/readyInit';
import { createDocumentSessionRuntime } from './documentSessionRuntime';
import { createDocumentSessionTransport } from './documentSessionTransport';

export type DocumentSessionViewPosition = {
  readonly topLine: number;
  readonly topLineOffset: number;
};

export type DocumentSessionWebviewAdapter = {
  start(message: InitMessage): void;
  accept(message: HostToWebviewMessage): boolean;
  localDraftChanged(text: string): void;
  requestSave(): void;
  requestReloadFromDisk(position: DocumentSessionViewPosition): void;
  whenIdle(): Promise<void>;
  dispose(): void;
};

export type DocumentSessionWebviewAdapterDependencies = {
  readonly postMessage: (message: WebviewToHostMessage) => void;
  readonly presentText: (
    text: string,
    source: 'revision' | 'rebased-draft' | 'disk-reload'
  ) => boolean | void;
  readonly restoreReloadedView: (message: DocumentReloadedFromDiskMessage) => void;
  readonly showFailureNotice: (message: string) => void;
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
    postMessage: dependencies.postMessage,
    presentText: dependencies.presentText,
    executeRemote: (action) => transport.execute(action),
    showFailureNotice: dependencies.showFailureNotice
  });
  let operation: Promise<void> = Promise.resolve();
  let started = false;
  let ready = false;
  let disposed = false;

  const enqueue = (context: string, task: () => Promise<void> | void): void => {
    if (disposed) return;
    operation = operation
      .then(task)
      .catch((error) => dependencies.reportUnexpectedError(context, error));
  };

  const enqueueSession = (context: string, task: () => Promise<void> | void): void => {
    enqueue(context, async () => {
      if (disposed) return;
      if (!ready) throw new Error('Document Session received input before Init');
      await task();
    });
  };

  const acceptSessionMessage = (message: HostToWebviewMessage): boolean => {
    if (message.type === 'saveDocumentRevisionResult' || message.type === 'documentRevisionResult') {
      transport.accept(message);
      return true;
    }
    if (message.type === 'docChanged') {
      enqueueSession('Host Revision', () => runtime.handle({
        type: 'hostRevisionChanged',
        version: message.version,
        text: message.text
      }));
      return true;
    }
    if (message.type === 'applied') {
      enqueueSession('accepted Change', () => runtime.handle({
        type: 'hostChangeApplied',
        version: message.version
      }));
      return true;
    }
    if (message.type === 'documentReloadedFromDisk') {
      enqueueSession('document reload', async () => {
        await runtime.handle({
          type: 'hostReloadedFromDisk',
          version: message.version,
          text: message.text
        });
        if (!disposed) dependencies.restoreReloadedView(message);
      });
      return true;
    }
    if (message.type === 'documentReloadFromDiskFailed') {
      enqueueSession('document reload failure', () => dependencies.showFailureNotice(message.message));
      return true;
    }
    return false;
  };

  return {
    start(message) {
      if (started || disposed) return;
      started = true;
      enqueue('start', async () => {
        if (disposed) return;
        await runtime.initialize(message);
        ready = true;
      });
    },
    accept(message) {
      return acceptSessionMessage(message);
    },
    localDraftChanged(text) {
      enqueueSession('local draft', async () => {
        const changed = runtime.handle({ type: 'localDraftChanged', text });
        const submitted = runtime.handle({ type: 'submitPendingDraft' });
        await Promise.all([changed, submitted]);
      });
    },
    requestSave() {
      enqueueSession('save', () => runtime.handle({ type: 'saveRequested' }));
    },
    requestReloadFromDisk(position) {
      enqueueSession('document reload request', async () => {
        await runtime.whenIdle();
        if (disposed) return;
        dependencies.postMessage({
          type: 'reloadDocumentFromDisk',
          topLine: position.topLine,
          topLineOffset: position.topLineOffset
        });
      });
    },
    whenIdle() {
      return operation;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      transport.cancelAll('Document Session closed');
    }
  };
}
