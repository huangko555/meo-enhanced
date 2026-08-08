import {
  createDocumentSession,
  transitionDocumentSession,
  type DocumentSessionEffect,
  type DocumentSessionEvent,
  type DocumentSessionState,
  type Revision,
  type SavedRevision
} from '../domain/documentSession';

export type DocumentSessionInput =
  | { readonly type: 'localDraftChanged'; readonly text: string }
  | { readonly type: 'submitPendingDraft' }
  | { readonly type: 'hostChangeApplied'; readonly version: number }
  | { readonly type: 'hostRevisionChanged'; readonly version: number; readonly text: string }
  | { readonly type: 'saveRequested' }
  | { readonly type: 'hostSaveSucceeded'; readonly version: number; readonly text: string }
  | {
      readonly type: 'hostSaveFailed';
      readonly version: number;
      readonly text: string;
      readonly message?: string;
    }
  | { readonly type: 'hostRevisionRequestFailed'; readonly message: string }
  | { readonly type: 'hostDiscardSucceeded'; readonly version: number; readonly text: string };

export type ApplicationTextChange = {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
};

export type DocumentSessionAction =
  | { readonly type: 'rememberDraft'; readonly text: string | null }
  | {
      readonly type: 'applyTextChange';
      readonly baseVersion: number;
      readonly changes: readonly ApplicationTextChange[];
    }
  | {
      readonly type: 'presentText';
      readonly text: string;
      readonly source: 'revision' | 'rebased-draft';
    }
  | { readonly type: 'saveDocument'; readonly revision: Revision }
  | { readonly type: 'requestRevision' };

export type DocumentSessionCoordinator = {
  readonly handle: (input: DocumentSessionInput) => readonly DocumentSessionAction[];
};

/**
 * Coordinates validated editor and Host inputs through the deterministic Domain
 * model. Adapters execute the returned actions; this module performs no I/O.
 */
export function createDocumentSessionCoordinator(input: {
  readonly documentId: string;
  readonly revision: Revision;
  readonly savedRevision: SavedRevision | null;
}): DocumentSessionCoordinator {
  let state = createDocumentSession(input);

  return {
    handle(applicationInput) {
      const event = mapInput(state, applicationInput);
      if (event === null) return [];

      const previousState = state;
      const transition = transitionDocumentSession(state, event);
      state = transition.state;
      return mapEffects(previousState, state, transition.effects);
    }
  };
}

function mapInput(
  state: DocumentSessionState,
  input: DocumentSessionInput
): DocumentSessionEvent | null {
  if (input.type === 'localDraftChanged') {
    return { type: 'draftChanged', text: input.text };
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
    type: 'discardCompleted',
    revision: { number: input.version, text: input.text }
  };
}

function mapEffects(
  previousState: DocumentSessionState,
  nextState: DocumentSessionState,
  effects: readonly DocumentSessionEffect[]
): readonly DocumentSessionAction[] {
  return effects.map((effect): DocumentSessionAction => {
    if (effect.type === 'persistDraft') {
      return { type: 'rememberDraft', text: effect.draft?.text ?? null };
    }
    if (effect.type === 'submitChange') {
      const baseRevision = nextState.revision.number === effect.change.baseRevision
        ? nextState.revision
        : previousState.revision;
      return {
        type: 'applyTextChange',
        baseVersion: effect.change.baseRevision,
        changes: [{ from: 0, to: baseRevision.text.length, insert: effect.change.text }]
      };
    }
    if (effect.type === 'presentText') {
      return {
        type: 'presentText',
        text: effect.text,
        source: effect.source
      };
    }
    if (effect.type === 'saveRevision') {
      return { type: 'saveDocument', revision: effect.revision };
    }
    return { type: 'requestRevision' };
  });
}
