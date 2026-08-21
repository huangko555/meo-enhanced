import type {
  DocumentSessionAction,
  DocumentSessionInput,
  DocumentPresentationSource
} from '../../../src/application/documentSession';
import type {
  ApplyChangesMessage,
  DraftChangedMessage
} from '../../../src/protocol/documentSync';

type RemoteDocumentSessionAction = Extract<
  DocumentSessionAction,
  { readonly type: 'saveDocument' | 'requestRevision' }
>;

export type DocumentSessionActionAdapter = {
  execute(actions: readonly DocumentSessionAction[]): Promise<boolean>;
};

export type DocumentSessionActionAdapterDependencies = {
  readonly postMessage: (message: ApplyChangesMessage | DraftChangedMessage) => void;
  readonly presentText: (
    text: string,
    source: DocumentPresentationSource
  ) => boolean | void | Promise<boolean | void>;
  readonly executeRemote: (action: RemoteDocumentSessionAction) => Promise<DocumentSessionInput>;
  readonly handleInput: (input: DocumentSessionInput) => readonly DocumentSessionAction[];
  readonly showFailureNotice: (message: string) => void;
};

const MAX_REVISION_REQUEST_ATTEMPTS = 2;
const RESYNC_FAILURE_NOTICE = 'Could not resynchronize the document. Local edits were kept.';

/**
 * Executes Application effects against Webview capabilities. The Adapter owns
 * only one bounded execution queue; Document Session state remains in the
 * Application coordinator supplied through handleInput.
 */
export function createDocumentSessionActionAdapter(
  dependencies: DocumentSessionActionAdapterDependencies
): DocumentSessionActionAdapter {
  return {
    async execute(actions) {
      const queue = Array.from(actions);
      const defersDiskReloadRecoveryClear = actions.some((action) => (
        action.type === 'presentText' && action.source === 'disk-reload'
      ));
      let revisionRequestAttempts = 0;
      let presentationSucceeded = true;

      while (queue.length > 0) {
        const action = queue.shift();
        if (!action) continue;

        if (action.type === 'rememberDraft') {
          if (defersDiskReloadRecoveryClear && action.text === null) continue;
          dependencies.postMessage({ type: 'draftChanged', text: action.text });
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
          if (await dependencies.presentText(action.text, action.source) === false) {
            presentationSucceeded = false;
          }
          continue;
        }
        if (action.type === 'requestRevision'
          && revisionRequestAttempts >= MAX_REVISION_REQUEST_ATTEMPTS) {
          dependencies.showFailureNotice(RESYNC_FAILURE_NOTICE);
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
            dependencies.showFailureNotice(RESYNC_FAILURE_NOTICE);
          }
          continue;
        }
        queue.unshift(...nextActions);
      }
      return presentationSucceeded;
    }
  };
}
