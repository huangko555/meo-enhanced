import type {
  DocumentSessionAction,
  DocumentSessionInput,
  DocumentPresentationCompletion,
  DocumentPresentationSource
} from '../../../src/application/documentSession';
import type {
  ApplyChangesMessage,
  DraftRecoveryMessage
} from '../../../src/protocol/documentSync';
import { createDocumentTextReplacement } from '../../../src/foundation/documentText';

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
  resendDraftRecovery(): void;
};

export type DocumentSessionActionAdapterDependencies = {
  readonly postMessage: (message: ApplyChangesMessage | DraftRecoveryMessage) => void;
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
  // Compression checkpoints only. Draft truth and receipt allocation remain in
  // the coordinator; null recovery clears retain the last text checkpoint.
  let recoveryCheckpoint: { text: string; receiptVersion: number } | null = null;
  let latestRecovery: Extract<DocumentSessionAction, { readonly type: 'rememberDraft' }> | null = null;
  const postRecovery = (action: NonNullable<typeof latestRecovery>, forceSnapshot = false): void => {
    let message: DraftRecoveryMessage = {
      type: 'draftChanged', text: action.text, receiptVersion: action.receiptVersion
    };
    if (!forceSnapshot && action.text !== null && action.text.length >= 262_144 && recoveryCheckpoint) {
      const change = createDocumentTextReplacement(recoveryCheckpoint.text, action.text);
      if (change.insert.length + 128 < action.text.length) {
        message = {
          type: 'draftPatched', change,
          baseReceiptVersion: recoveryCheckpoint.receiptVersion,
          receiptVersion: action.receiptVersion
        };
      }
    }
    dependencies.postMessage(message);
    if (action.text !== null) recoveryCheckpoint = { text: action.text, receiptVersion: action.receiptVersion };
    latestRecovery = action;
  };
  const present = async (
    action: Extract<DocumentSessionAction, { readonly type: 'presentText' }>
  ): Promise<boolean> => {
    const succeeded = await dependencies.presentText(action.text, action.source) !== false;
    // A disk reload also requires a Host receipt; retry that complete operation instead.
    failedPresentation = succeeded || action.source === 'disk-reload' ? null : action;
    return succeeded;
  };
  return {
    resendDraftRecovery() {
      if (latestRecovery) postRecovery(latestRecovery, true);
    },
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
          postRecovery(action);
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
