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
import { equalDocumentText, readDocumentText, type DocumentText, type DocumentTextEdit,
  type DocumentTextSnapshot } from '../foundation/documentSnapshot';

export type { DocumentPresentationSource } from '../domain/documentSession';
export type { DocumentPresentationCompletion } from '../domain/documentSession';

export type DocumentSessionInput =
  | { readonly type: 'localDraftChanged'; readonly text: DocumentText; readonly edit?: DocumentTextEdit }
  /** A native-input recovery projection which must not become the session Draft. */
  | {
      readonly type: 'localRecoveryDraftChanged';
      /** Accepted CodeMirror source that the projection was derived from. */
      readonly source: DocumentText;
      readonly text: DocumentText;
      readonly edit?: DocumentTextEdit;
    }
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
      /** The Host revision the candidate must still be based on at recovery. */
      readonly baseVersion?: number;
      /** Terminal conflict context; sent only when normal merge is impossible. */
      readonly conflictBaseText?: DocumentText;
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
  readonly currentText: () => DocumentText;
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
  // This is a bounded projection of a still-native table cell, not another
  // Draft or document owner. It exists solely so an older Host acknowledgement
  // cannot overwrite a newer recovery candidate before that cell commits.
  let recoveryProjection: {
    readonly source: DocumentText;
    readonly text: DocumentText;
    /** Original source → latest projection; only external rebase uses this. */
    readonly rebaseEdit?: DocumentTextEdit;
    /** Previous projection → latest projection; only recovery transport uses this. */
    readonly transportEdit?: DocumentTextEdit;
  } | null = null;
  // `presentText` constructs a fresh CodeMirror Text tree in the editor. A
  // recovery projection therefore cannot rely on reference equality with the
  // canonical session snapshot after an external presentation. Validate that
  // pair once, then retain only the immutable identities while both survive.
  let validatedRecoverySource: DocumentText | null = null;
  let validatedAcceptedSource: DocumentText | null = null;

  const currentText = (): DocumentText => state.draft?.text ?? state.revision.text;
  const sourceMatchesCurrentText = (source: DocumentText): boolean => {
    const accepted = currentText();
    if (recoveryProjection !== null
      && validatedRecoverySource === source && validatedAcceptedSource === accepted) return true;
    return equalDocumentText(source, accepted);
  };
  const clearRecoveryProjection = (): void => {
    recoveryProjection = null;
    validatedRecoverySource = null;
    validatedAcceptedSource = null;
  };
  const projectedRecoveryAction = (
    projection: NonNullable<typeof recoveryProjection>,
    receiptVersion: number
  ): Extract<DocumentSessionAction, { readonly type: 'rememberDraft' }> => ({
    type: 'rememberDraft',
    text: projection.text,
    baseVersion: state.draft?.baseRevision ?? state.revision.number,
    ...(state.draft?.conflictBaseText !== undefined
      ? { conflictBaseText: state.draft.conflictBaseText } : {}),
    ...(projection.transportEdit && equalDocumentText(projection.transportEdit.after, projection.text)
      ? { edit: projection.transportEdit } : {}),
    receiptVersion
  });

  return {
    handle(applicationInput) {
      const canonicalInput: DocumentSessionInput = applicationInput.type === 'localRecoveryDraftChanged'
        ? {
            ...applicationInput,
            source: canonicalText(applicationInput.source),
            text: canonicalText(applicationInput.text)
          }
        : 'text' in applicationInput
          ? { ...applicationInput, text: canonicalText(applicationInput.text) }
          : applicationInput;
      const inputReceiptVersion = canProduceDraftRecoveryEffect(canonicalInput)
        ? nextDraftRecoveryReceiptVersion++
        : null;
      if (canonicalInput.type === 'localRecoveryDraftChanged') {
        const acceptedSource = currentText();
        // A native textarea can outlive a document replacement briefly. Its
        // projection is valid only for the exact accepted source it observed.
        if (!sourceMatchesCurrentText(canonicalInput.source)) return [];
        if (inputReceiptVersion === null) {
          throw new Error('Draft recovery effect was emitted by an unordered Document Session input');
        }
        const clearsProjection = equalDocumentText(canonicalInput.text, acceptedSource);
        if (clearsProjection) {
          clearRecoveryProjection();
        } else {
          const previousProjection = recoveryProjection;
          const rebaseEdit = previousProjection?.rebaseEdit && canonicalInput.edit
            ? previousProjection.rebaseEdit.compose(canonicalInput.edit)
            : canonicalInput.edit;
          recoveryProjection = {
            source: canonicalInput.source,
            text: canonicalInput.text,
            ...(rebaseEdit ? { rebaseEdit } : {}),
            ...(canonicalInput.edit ? { transportEdit: canonicalInput.edit } : {})
          };
          // Retain the cross-boundary Text identity pair only for this active
          // projection. Any acceptance/rebase path clears both references.
          validatedRecoverySource = canonicalInput.source;
          validatedAcceptedSource = acceptedSource;
        }
        const projection = recoveryProjection;
        const recovery: Extract<DocumentSessionAction, { readonly type: 'rememberDraft' }> = clearsProjection
          ? {
              type: 'rememberDraft',
              text: state.draft === null ? null : state.draft.text,
              ...(state.draft === null ? {} : {
                baseVersion: state.draft.baseRevision,
                ...(state.draft.conflictBaseText !== undefined
                  ? { conflictBaseText: state.draft.conflictBaseText } : {}),
                ...(state.draft.edit ? { edit: state.draft.edit } : {})
              }),
              receiptVersion: inputReceiptVersion
            }
          : projectedRecoveryAction(projection!, inputReceiptVersion);
        latestDraftRecoveryReceiptVersion = inputReceiptVersion;
        return [recovery];
      }
      const event = mapInput(state, canonicalInput);
      if (event === null) return [];

      const previousState = state;
      const transition = transitionDocumentSession(state, event);
      state = transition.state;
      let actions = mapEffects(
        previousState,
        state,
        transition.effects,
        inputReceiptVersion,
        canonicalInput.type === 'localDraftChanged' ? canonicalInput.edit : undefined
      );
      if (validatedAcceptedSource !== null && validatedAcceptedSource !== currentText()) {
        // The accepted document identity changed. Retain no historical large
        // Text through the validation fast path while rebase decides the
        // active projection's fate below.
        validatedRecoverySource = null;
        validatedAcceptedSource = null;
      }
      if (recoveryProjection) {
        const acceptedSource = currentText();
        if (equalDocumentText(acceptedSource, recoveryProjection.text)) {
          // Either the normal native transaction or a Host revision accepted
          // this projection. Host convergence still owes the local input its
          // history entry before external presentation retires the textarea.
          if (canonicalInput.type === 'hostChangeApplied' || canonicalInput.type === 'hostRevisionChanged') {
            actions = actions.map(action => action.type === 'presentText'
              ? { ...action, source: 'rebased-draft' as const } : action);
            if (state.draft === null && inputReceiptVersion !== null
              && !actions.some(action => action.type === 'rememberDraft')) {
              actions = [...actions, { type: 'rememberDraft', text: null, receiptVersion: inputReceiptVersion }];
            }
          }
          clearRecoveryProjection();
        } else if (equalDocumentText(acceptedSource, recoveryProjection.source)) {
          // Acknowledging an earlier Host change can advance the base revision
          // while the native textarea remains uncommitted. Keep its recovery
          // candidate newest without submitting it as a document change.
          if (inputReceiptVersion !== null && (
            canonicalInput.type === 'hostChangeApplied' || canonicalInput.type === 'hostRevisionChanged'
          )) {
            const recovery = projectedRecoveryAction(recoveryProjection, inputReceiptVersion);
            const replacement = actions.findIndex(action => action.type === 'rememberDraft');
            actions = replacement < 0
              ? [...actions, recovery]
              : actions.map((action, index) => index === replacement ? recovery : action);
          }
        } else if (inputReceiptVersion !== null && recoveryProjection.rebaseEdit && (
          canonicalInput.type === 'hostChangeApplied' || canonicalInput.type === 'hostRevisionChanged'
        )) {
          // Re-enter the existing Draft transition after the newer Host source
          // has been accepted. This reuses its disjoint rebase/conflict rules
          // without turning the native projection into an early submission.
          const projection = recoveryProjection;
          clearRecoveryProjection();
          const recoveryEvent = mapInput(state, {
            type: 'localDraftChanged', text: projection.text, edit: projection.rebaseEdit
          });
          if (recoveryEvent === null) throw new Error('Native recovery projection was not mappable');
          const recoveryPreviousState = state;
          const recoveryTransition = transitionDocumentSession(state, recoveryEvent);
          state = recoveryTransition.state;
          const recoveryActions = Array.from(mapEffects(
            recoveryPreviousState,
            state,
            recoveryTransition.effects,
            inputReceiptVersion,
            projection.rebaseEdit
          ));
          if (state.draft?.conflictBaseText !== undefined
            && !recoveryActions.some(action => action.type === 'presentText')) {
            // The conflicting Draft is the coordinator's current editable
            // source. Present it locally (without an applyChanges action) so
            // the UI cannot continue editing the superseded Host text.
            recoveryActions.push({
              type: 'presentText',
              text: readDocumentText(state.draft.text),
              source: 'rebased-draft'
            });
          }
          // The rebased/conflict candidate supersedes the old Host action's
          // recovery receipt and presentation. Publish the final accepted
          // Draft once, retaining other effects such as save requests.
          const presentsRecoveredDraft = recoveryActions.some(action => action.type === 'presentText');
          actions = [
            ...actions.filter(action => action.type !== 'rememberDraft'
              && !(presentsRecoveredDraft && action.type === 'presentText')),
            ...recoveryActions
          ];
        } else {
          clearRecoveryProjection();
          if (inputReceiptVersion !== null && (
            canonicalInput.type === 'hostChangeApplied' || canonicalInput.type === 'hostRevisionChanged'
          ) && !actions.some(action => action.type === 'rememberDraft')) {
            actions = [...actions, {
              type: 'rememberDraft',
              text: null,
              receiptVersion: inputReceiptVersion
            }];
          }
        }
      }
      if (actions.some((action) => action.type === 'rememberDraft')) {
        if (inputReceiptVersion === null) {
          throw new Error('Draft recovery effect was emitted by an unordered Document Session input');
        }
        latestDraftRecoveryReceiptVersion = inputReceiptVersion;
      }
      return actions;
    },
    currentText: () => state.draft?.text ?? state.revision.text,
    draftRecoveryReceiptVersion: () => latestDraftRecoveryReceiptVersion
  };
}

function canProduceDraftRecoveryEffect(input: DocumentSessionInput): boolean {
  return input.type === 'localDraftChanged'
    || input.type === 'localRecoveryDraftChanged'
    || input.type === 'hostChangeApplied'
    || input.type === 'hostRevisionChanged';
}

function mapInput(
  state: DocumentSessionState,
  input: DocumentSessionInput
): DocumentSessionEvent | null {
  if (input.type === 'localRecoveryDraftChanged') return null;
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
        ...(effect.draft === null ? {} : {
          baseVersion: effect.draft.baseRevision,
          ...(effect.draft.conflictBaseText !== undefined ? { conflictBaseText: effect.draft.conflictBaseText } : {})
        }),
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
