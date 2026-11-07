import type {
  DocumentSessionAction,
  DocumentSessionCoordinator,
  DocumentSessionInput,
  DocumentPresentationCompletion,
  DocumentPresentationSource
} from '../../../src/application/documentSession';
import type { ApplyChangesMessage, DraftRecoveryMessage } from '../../../src/protocol/documentSync';
import type { InitMessage } from '../../../src/protocol/readyInit';
import {
  createDocumentSessionActionAdapter,
  type DocumentSessionActionAdapter,
  type DocumentSessionNotice
} from './documentSessionActions';
import { createDocumentSessionCoordinatorFromInit } from './documentSessionTransport';
import { documentSnapshotFromString } from './documentSnapshot';
import type { DocumentText } from '../../../src/foundation/documentSnapshot';

type RemoteDocumentSessionAction = Extract<
  DocumentSessionAction,
  { readonly type: 'saveDocument' | 'requestRevision' }
>;

export type DocumentSessionRuntime = {
  currentText(): DocumentText | null;
  initialize(message: InitMessage): Promise<void>;
  handle(
    input: DocumentSessionInput,
    onAccepted?: () => void
  ): Promise<readonly DocumentPresentationCompletion[]>;
  retryPresentation(): Promise<boolean>;
  resendDraftRecovery(): Promise<void>;
  draftRecoveryReceiptVersion(): number;
  whenIdle(): Promise<void>;
  dispose(pendingInputs?: readonly DocumentSessionInput[]): void;
};

export type DocumentSessionRuntimeDependencies = {
  readonly pageId: string;
  readonly postMessage: (message: ApplyChangesMessage | DraftRecoveryMessage) => void;
  readonly presentText: (
    text: string,
    source: DocumentPresentationSource
  ) => boolean | void | Promise<boolean | void>;
  readonly executeRemote: (action: RemoteDocumentSessionAction) => Promise<DocumentSessionInput>;
  readonly showNotice: (notice: DocumentSessionNotice) => void;
};

/** Owns the one production Document Session coordinator and serializes its inputs. */
export function createDocumentSessionRuntime(
  dependencies: DocumentSessionRuntimeDependencies
): DocumentSessionRuntime {
  let coordinator: DocumentSessionCoordinator | null = null;
  let actionAdapter: DocumentSessionActionAdapter | null = null;
  let operation: Promise<void> = Promise.resolve();
  let disposed = false;

  const enqueue = <Result>(task: () => Promise<Result>): Promise<Result> => {
    const result = operation.then(task);
    operation = result.then(() => undefined, () => undefined);
    return result;
  };

  const requireSession = (): {
    coordinator: DocumentSessionCoordinator;
    actionAdapter: DocumentSessionActionAdapter;
  } => {
    if (!coordinator || !actionAdapter) {
      throw new Error('Document Session received input before Init');
    }
    return { coordinator, actionAdapter };
  };

  return {
    currentText: () => disposed ? null : coordinator?.currentText() ?? null,
    initialize(message) {
      if (disposed || coordinator !== null) return operation;
      coordinator = createDocumentSessionCoordinatorFromInit(message, documentSnapshotFromString);
      actionAdapter = createDocumentSessionActionAdapter({
        ...dependencies,
        pageId: message.pageId,
        postMessage: message => { if (!disposed) dependencies.postMessage(message); },
        presentText: (text, source) => disposed ? false : dependencies.presentText(text, source),
        executeRemote: action => disposed ? Promise.reject(new Error('Document Session closed')) : dependencies.executeRemote(action),
        showNotice: notice => { if (!disposed) dependencies.showNotice(notice); },
        handleInput: (input) => disposed ? [] : requireSession().coordinator.handle(input)
      });
      return operation;
    },
    handle(input, onAccepted) {
      return enqueue(async () => {
        if (disposed) return [];
        const session = requireSession();
        const actions = session.coordinator.handle(input);
        // The adapter may retire a close-handoff receipt only after the sole
        // coordinator has actually consumed this exact input. Starting the
        // outer adapter task merely schedules this microtask.
        onAccepted?.();
        return session.actionAdapter.execute(actions);
      });
    },
    retryPresentation() {
      return enqueue(async () => disposed ? false : requireSession().actionAdapter.retryPresentation());
    },
    resendDraftRecovery() {
      return enqueue(async () => { if (!disposed) requireSession().actionAdapter.resendDraftRecovery(); });
    },
    draftRecoveryReceiptVersion() {
      return requireSession().coordinator.draftRecoveryReceiptVersion();
    },
    whenIdle() {
      return operation;
    },
    dispose(pendingInputs = []) {
      if (disposed) return;
      try {
        // Unload cannot wait for a remote request or microtask queue. Fold the
        // adapter's not-yet-accepted input receipts through the sole
        // coordinator in arrival order, then publish only their final recovery
        // action through the normal recovery encoder. This is deliberately not
        // a second document snapshot or undo stack.
        if (coordinator && actionAdapter) {
          let finalRecovery: Extract<DocumentSessionAction, { readonly type: 'rememberDraft' }> | null = null;
          for (const input of pendingInputs) {
            for (const action of coordinator.handle(input)) {
              if (action.type === 'rememberDraft') finalRecovery = action;
            }
          }
          if (finalRecovery) actionAdapter.preserveDraft(finalRecovery);
          else actionAdapter.preserveLatestDraft();
        }
      } finally { disposed = true; }
    }
  };
}
