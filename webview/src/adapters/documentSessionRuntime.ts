import type {
  DocumentSessionAction,
  DocumentSessionCoordinator,
  DocumentSessionInput,
  DocumentPresentationCompletion,
  DocumentPresentationSource
} from '../../../src/application/documentSession';
import type { ApplyChangesMessage, DraftChangedMessage } from '../../../src/protocol/documentSync';
import type { InitMessage } from '../../../src/protocol/readyInit';
import {
  createDocumentSessionActionAdapter,
  type DocumentSessionActionAdapter
} from './documentSessionActions';
import { createDocumentSessionCoordinatorFromInit } from './documentSessionTransport';

type RemoteDocumentSessionAction = Extract<
  DocumentSessionAction,
  { readonly type: 'saveDocument' | 'requestRevision' }
>;

export type DocumentSessionRuntime = {
  initialize(message: InitMessage): Promise<void>;
  handle(input: DocumentSessionInput): Promise<readonly DocumentPresentationCompletion[]>;
  draftRecoveryReceiptVersion(): number;
  whenIdle(): Promise<void>;
};

export type DocumentSessionRuntimeDependencies = {
  readonly postMessage: (message: ApplyChangesMessage | DraftChangedMessage) => void;
  readonly presentText: (
    text: string,
    source: DocumentPresentationSource
  ) => boolean | void | Promise<boolean | void>;
  readonly executeRemote: (action: RemoteDocumentSessionAction) => Promise<DocumentSessionInput>;
  readonly showFailureNotice: (message: string) => void;
};

/** Owns the one production Document Session coordinator and serializes its inputs. */
export function createDocumentSessionRuntime(
  dependencies: DocumentSessionRuntimeDependencies
): DocumentSessionRuntime {
  let coordinator: DocumentSessionCoordinator | null = null;
  let actionAdapter: DocumentSessionActionAdapter | null = null;
  let operation: Promise<void> = Promise.resolve();

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
    initialize(message) {
      if (coordinator !== null) return operation;
      coordinator = createDocumentSessionCoordinatorFromInit(message);
      actionAdapter = createDocumentSessionActionAdapter({
        ...dependencies,
        uiLanguage: message.uiLanguage,
        handleInput: (input) => requireSession().coordinator.handle(input)
      });
      return operation;
    },
    handle(input) {
      return enqueue(async () => {
        const session = requireSession();
        const actions = session.coordinator.handle(input);
        return session.actionAdapter.execute(actions);
      });
    },
    draftRecoveryReceiptVersion() {
      return requireSession().coordinator.draftRecoveryReceiptVersion();
    },
    whenIdle() {
      return operation;
    }
  };
}
