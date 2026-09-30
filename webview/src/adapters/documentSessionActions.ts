import type {
  DocumentSessionAction,
  DocumentSessionInput,
  DocumentPresentationCompletion,
  DocumentPresentationSource
} from '../../../src/application/documentSession';
import type {
  ApplyChangesMessage,
  DraftChangedMessage
} from '../../../src/protocol/documentSync';

export type DocumentSessionNotice =
  | 'external-conflict'
  | 'resync-failed'
  | 'reload-from-disk-failed';

type RemoteDocumentSessionAction = Extract<
  DocumentSessionAction,
  { readonly type: 'saveDocument' | 'requestRevision' }
>;

export type DocumentSessionActionAdapter = {
  execute(actions: readonly DocumentSessionAction[]): Promise<
    readonly DocumentPresentationCompletion[]
  >;
  retryPresentation(): Promise<boolean>;
};

export type DocumentSessionActionAdapterDependencies = {
  readonly postMessage: (message: ApplyChangesMessage | DraftChangedMessage) => void;
  readonly presentText: (
    text: string,
    source: DocumentPresentationSource
  ) => boolean | void | Promise<boolean | void>;
  readonly executeRemote: (action: RemoteDocumentSessionAction) => Promise<DocumentSessionInput>;
  readonly handleInput: (input: DocumentSessionInput) => readonly DocumentSessionAction[];
  readonly showNotice: (notice: DocumentSessionNotice) => void;
};

const MAX_REVISION_REQUEST_ATTEMPTS = 2;
/**
 * Executes Application effects against Webview capabilities. The Adapter owns
 * only one bounded execution queue; Document Session state remains in the
 * Application coordinator supplied through handleInput.
 */
export function createDocumentSessionActionAdapter(
  dependencies: DocumentSessionActionAdapterDependencies
): DocumentSessionActionAdapter {
  let failedPresentation: Extract<DocumentSessionAction, { readonly type: 'presentText' }> | null = null;
  const present = async (
    action: Extract<DocumentSessionAction, { readonly type: 'presentText' }>
  ): Promise<boolean> => {
    const succeeded = await dependencies.presentText(action.text, action.source) !== false;
    // A disk reload also requires a Host receipt; retry that complete operation instead.
    failedPresentation = succeeded || action.source === 'disk-reload' ? null : action;
    return succeeded;
  };
  return {
    async retryPresentation() {
      return failedPresentation ? present(failedPresentation) : false;
    },
    async execute(actions) {
      const queue = Array.from(actions);
      let revisionRequestAttempts = 0;
      const completions: DocumentPresentationCompletion[] = [];

      while (queue.length > 0) {
        const action = queue.shift();
        if (!action) continue;

        if (action.type === 'rememberDraft') {
          failedPresentation = null;
          dependencies.postMessage({
            type: 'draftChanged',
            text: action.text,
            receiptVersion: action.receiptVersion
          });
          continue;
        }
        if (action.type === 'applyTextChange') {
          dependencies.postMessage({
            type: 'applyChanges',
            baseVersion: action.baseVersion,
            changes: Array.from(action.changes)
          });
          continue;
        }
        if (action.type === 'presentText') {
          if (await present(action) && action.onPresented) {
            completions.push(action.onPresented);
          }
          continue;
        }
        if (action.type === 'showExternalConflict') {
          dependencies.showNotice('external-conflict');
          continue;
        }
        if (action.type === 'requestRevision'
          && revisionRequestAttempts >= MAX_REVISION_REQUEST_ATTEMPTS) {
          dependencies.showNotice('resync-failed');
          continue;
        }

        if (action.type === 'requestRevision') {
          revisionRequestAttempts += 1;
        }
        const input = await dependencies.executeRemote(action);
        const nextActions = dependencies.handleInput(input);
        if (input.type === 'hostRevisionRequestFailed') {
          if (revisionRequestAttempts < MAX_REVISION_REQUEST_ATTEMPTS) {
            queue.unshift(action);
          } else {
            dependencies.showNotice('resync-failed');
          }
          continue;
        }
        queue.unshift(...nextActions);
      }
      return completions;
    }
  };
}
