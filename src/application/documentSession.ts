import {
  createDocumentSession,
  transitionDocumentSession,
  type DocumentSessionEffect,
  type DocumentSessionEvent,
  type DocumentPresentationCompletion,
  type DocumentPresentationSource,
  type DocumentSessionState,
  type Revision,
  type SavedRevision
} from '../domain/documentSession';
import { createDocumentTextReplacement, normalizeDocumentText } from '../foundation/documentText';
import { readDocumentText, type DocumentText, type DocumentTextEdit,
  type DocumentTextSnapshot } from '../foundation/documentSnapshot';

export type { DocumentPresentationSource } from '../domain/documentSession';
export type { DocumentPresentationCompletion } from '../domain/documentSession';

export type DocumentSessionInput =
  | { readonly type: 'localDraftChanged'; readonly text: DocumentText; readonly edit?: DocumentTextEdit }
  | { readonly type: 'submitPendingDraft' }
  | { readonly type: 'hostChangeApplied'; readonly version: number }
  | { readonly type: 'hostRevisionChanged'; readonly version: number; readonly text: DocumentText }
  | { readonly type: 'saveRequested' }
  | { readonly type: 'hostSaveSucceeded'; readonly version: number; readonly text: DocumentText }
  | {
      readonly type: 'hostSaveFailed';
      readonly version: number;
      readonly text: DocumentText;
      readonly message?: string;
    }
  | { readonly type: 'hostRevisionRequestFailed'; readonly message: string }
  | { readonly type: 'hostReloadedFromDisk'; readonly version: number; readonly text: DocumentText };

export type ApplicationTextChange = {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
};

export type DocumentSessionAction =
  | {
      readonly type: 'rememberDraft';
      readonly text: DocumentText | null;
      readonly receiptVersion: number;
      readonly edit?: DocumentTextEdit;
    }
  | {
      readonly type: 'applyTextChange';
      readonly baseVersion: number;
      readonly changes: readonly ApplicationTextChange[];
    }
  | {
      readonly type: 'presentText';
      readonly text: string;
      readonly source: DocumentPresentationSource;
      readonly onPresented?: DocumentPresentationCompletion;
    }
  | { readonly type: 'showExternalConflict' }
  | { readonly type: 'saveDocument'; readonly revision: Revision }
  | { readonly type: 'requestRevision' };

export type DocumentSessionCoordinator = {
  readonly handle: (input: DocumentSessionInput) => readonly DocumentSessionAction[];
  /** Latest recovery effect receipt emitted by this ordered Interface. */
  readonly draftRecoveryReceiptVersion: () => number;
};

/**
 * Orders validated editor and Host inputs through the deterministic Domain model.
 * This Interface is the sole Draft Recovery Receipt allocator; Adapters only
 * execute and propagate its returned actions.
 */
export function createDocumentSessionCoordinator(input: {
  readonly documentId: string;
  readonly revision: Revision;
  readonly savedRevision: SavedRevision | null;
  readonly createTextSnapshot?: (text: string) => DocumentTextSnapshot;
}): DocumentSessionCoordinator {
  const canonicalText = (text: DocumentText): DocumentText => typeof text === 'string'
    ? input.createTextSnapshot?.(text) ?? normalizeDocumentText(text) : text;
  let state = createDocumentSession({
    ...input,
    revision: { ...input.revision, text: canonicalText(input.revision.text) },
    savedRevision: input.savedRevision === null ? null : {
      ...input.savedRevision, text: canonicalText(input.savedRevision.text)
    }
  });
  let nextDraftRecoveryReceiptVersion = 1;
  let latestDraftRecoveryReceiptVersion = 0;

  return {
    handle(applicationInput) {
      const canonicalInput: DocumentSessionInput = 'text' in applicationInput
        ? { ...applicationInput, text: canonicalText(applicationInput.text) }
        : applicationInput;
      const inputReceiptVersion = canProduceDraftRecoveryEffect(canonicalInput)
        ? nextDraftRecoveryReceiptVersion++
        : null;
      const event = mapInput(state, canonicalInput);
      if (event === null) return [];

      const previousState = state;
      const transition = transitionDocumentSession(state, event);
      state = transition.state;
      const actions = mapEffects(
        previousState,
        state,
        transition.effects,
        inputReceiptVersion,
        canonicalInput.type === 'localDraftChanged' ? canonicalInput.edit : undefined
      );
      if (actions.some((action) => action.type === 'rememberDraft')) {
        if (inputReceiptVersion === null) {
          throw new Error('Draft recovery effect was emitted by an unordered Document Session input');
        }
        latestDraftRecoveryReceiptVersion = inputReceiptVersion;
      }
      return actions;
    },
    draftRecoveryReceiptVersion: () => latestDraftRecoveryReceiptVersion
  };
}

function canProduceDraftRecoveryEffect(input: DocumentSessionInput): boolean {
  return input.type === 'localDraftChanged'
    || input.type === 'hostChangeApplied'
    || input.type === 'hostRevisionChanged';
}

function mapInput(
  state: DocumentSessionState,
  input: DocumentSessionInput
): DocumentSessionEvent | null {
  if (input.type === 'localDraftChanged') {
    return { type: 'draftChanged', text: input.text, ...(input.edit ? { edit: input.edit } : {}) };
  }
  if (input.type === 'submitPendingDraft') {
    return { type: 'submitDraft' };
  }
  if (input.type === 'hostChangeApplied') {
    if (state.pendingChange === null || input.version <= state.pendingChange.baseRevision) {
      return null;
    }
    return {
      type: 'revisionReceived',
      revision: { number: input.version, text: state.pendingChange.text }
    };
  }
  if (input.type === 'hostRevisionChanged') {
    return {
      type: 'revisionReceived',
      revision: { number: input.version, text: input.text }
    };
  }
  if (input.type === 'saveRequested') {
    return { type: 'saveRequested' };
  }
  if (input.type === 'hostSaveSucceeded') {
    return {
      type: 'saveCompleted',
      revision: { number: input.version, text: input.text }
    };
  }
  if (input.type === 'hostSaveFailed') {
    return {
      type: 'saveFailed',
      revision: { number: input.version, text: input.text }
    };
  }
  if (input.type === 'hostRevisionRequestFailed') {
    return null;
  }
  return {
    type: 'reloadedFromDisk',
    revision: { number: input.version, text: input.text }
  };
}

function mapEffects(
  previousState: DocumentSessionState,
  nextState: DocumentSessionState,
  effects: readonly DocumentSessionEffect[],
  inputReceiptVersion: number | null,
  localEdit?: DocumentTextEdit
): readonly DocumentSessionAction[] {
  return effects.map((effect): DocumentSessionAction => {
    if (effect.type === 'persistDraft') {
      if (inputReceiptVersion === null) {
        throw new Error('Draft recovery effect requires an ordered input receipt');
      }
      return {
        type: 'rememberDraft',
        text: effect.draft?.text ?? null,
        receiptVersion: inputReceiptVersion,
        ...(localEdit && effect.draft?.text === localEdit.after ? { edit: localEdit } : {})
      };
    }
    if (effect.type === 'submitChange') {
      const baseRevision = nextState.revision.number === effect.change.baseRevision
        ? nextState.revision
        : previousState.revision;
      return {
        type: 'applyTextChange',
        baseVersion: effect.change.baseRevision,
        changes: effect.change.edit?.changes
          ?? [createDocumentTextReplacement(readDocumentText(baseRevision.text), readDocumentText(effect.change.text))]
      };
    }
    if (effect.type === 'presentText') {
      return {
        type: 'presentText',
        text: readDocumentText(effect.text),
        source: effect.source,
        ...(effect.onPresented ? { onPresented: effect.onPresented } : {})
      };
    }
    if (effect.type === 'saveRevision') {
      return { type: 'saveDocument', revision: effect.revision };
    }
    if (effect.type === 'reportExternalConflict') {
      return { type: 'showExternalConflict' };
    }
    return { type: 'requestRevision' };
  });
}
