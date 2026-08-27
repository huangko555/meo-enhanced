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
import { getGeneratedUiStrings, type UiLanguage } from '../../../src/foundation/uiLanguage';

type RemoteDocumentSessionAction = Extract<
  DocumentSessionAction,
  { readonly type: 'saveDocument' | 'requestRevision' }
>;

export type DocumentSessionActionAdapter = {
  execute(actions: readonly DocumentSessionAction[]): Promise<
    readonly DocumentPresentationCompletion[]
  >;
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
  readonly uiLanguage: UiLanguage;
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
  const uiStrings = getGeneratedUiStrings(dependencies.uiLanguage);
  return {
    async execute(actions) {
      const queue = Array.from(actions);
      let revisionRequestAttempts = 0;
      const completions: DocumentPresentationCompletion[] = [];

      while (queue.length > 0) {
        const action = queue.shift();
        if (!action) continue;

        if (action.type === 'rememberDraft') {
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
          if (await dependencies.presentText(action.text, action.source) !== false
            && action.onPresented) {
            completions.push(action.onPresented);
          }
          continue;
        }
        if (action.type === 'showExternalConflict') {
          dependencies.showFailureNotice(uiStrings.externalConflictNotice);
          continue;
        }
        if (action.type === 'requestRevision'
          && revisionRequestAttempts >= MAX_REVISION_REQUEST_ATTEMPTS) {
          dependencies.showFailureNotice(uiStrings.resyncFailureNotice);
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
            dependencies.showFailureNotice(uiStrings.resyncFailureNotice);
          }
          continue;
        }
        queue.unshift(...nextActions);
      }
      return completions;
    }
  };
}
