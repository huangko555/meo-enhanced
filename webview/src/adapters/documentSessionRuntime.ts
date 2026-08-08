import type {
  DocumentSessionAction,
  DocumentSessionCoordinator,
  DocumentSessionInput
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
  handle(input: DocumentSessionInput): Promise<void>;
  whenIdle(): Promise<void>;
};

export type DocumentSessionRuntimeDependencies = {
  readonly postMessage: (message: ApplyChangesMessage | DraftChangedMessage) => void;
  readonly presentText: (
    text: string,
    source: 'revision' | 'rebased-draft'
  ) => boolean | void;
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

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const result = operation.then(task);
    operation = result.catch(() => undefined);
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
        handleInput: (input) => requireSession().coordinator.handle(input)
      });
      return operation;
    },
    handle(input) {
      return enqueue(async () => {
        const session = requireSession();
        await session.actionAdapter.execute(session.coordinator.handle(input));
      });
    },
    whenIdle() {
      return operation;
    }
  };
}
