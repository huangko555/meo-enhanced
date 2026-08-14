export type Revision = {
  readonly number: number;
  readonly text: string;
};

export type Draft = {
  readonly baseRevision: number;
  readonly text: string;
};

export type Change = {
  readonly baseRevision: number;
  readonly text: string;
};

export type SavedRevision = {
  readonly revisionNumber: number | null;
  readonly text: string;
};

export type DocumentPresentationSource = 'revision' | 'rebased-draft' | 'disk-reload';

export type DocumentSessionState = {
  readonly documentId: string;
  readonly revision: Revision;
  readonly savedRevision: SavedRevision | null;
  readonly draft: Draft | null;
  readonly pendingChange: Change | null;
  readonly savePhase: 'idle' | 'awaiting-change' | 'saving';
  readonly savingRevision: Revision | null;
};

export type DocumentSessionEvent =
  | { readonly type: 'draftChanged'; readonly text: string }
  | { readonly type: 'submitDraft' }
  | { readonly type: 'revisionReceived'; readonly revision: Revision }
  | { readonly type: 'saveRequested' }
  | { readonly type: 'saveCompleted'; readonly revision: Revision }
  | { readonly type: 'saveFailed'; readonly revision: Revision }
  | { readonly type: 'reloadedFromDisk'; readonly revision: Revision };

export type DocumentSessionEffect =
  | { readonly type: 'persistDraft'; readonly draft: Draft | null }
  | { readonly type: 'submitChange'; readonly change: Change }
  | {
      readonly type: 'presentText';
      readonly text: string;
      readonly source: DocumentPresentationSource;
    }
  | { readonly type: 'requestResync' }
  | { readonly type: 'saveRevision'; readonly revision: Revision };

export type DocumentSessionTransition = {
  readonly state: DocumentSessionState;
  readonly effects: readonly DocumentSessionEffect[];
};

/** Creates the single authoritative state for one accepted document revision. */
export function createDocumentSession(input: {
  readonly documentId: string;
  readonly revision: Revision;
  readonly savedRevision: SavedRevision | null;
}): DocumentSessionState {
  return {
    documentId: input.documentId,
    revision: input.revision,
    savedRevision: input.savedRevision,
    draft: null,
    pendingChange: null,
    savePhase: 'idle',
    savingRevision: null
  };
}

/**
 * Applies one validated domain event without performing I/O. Callers execute
 * returned effects and feed acknowledgements back as later events.
 */
export function transitionDocumentSession(
  state: DocumentSessionState,
  event: DocumentSessionEvent
): DocumentSessionTransition {
  if (event.type === 'draftChanged') {
    if (state.pendingChange === null && event.text === state.revision.text) {
      if (state.draft === null) return { state, effects: [] };
      return {
        state: { ...state, draft: null },
        effects: [{ type: 'persistDraft', draft: null }]
      };
    }
    const draft = { baseRevision: state.revision.number, text: event.text };
    return {
      state: { ...state, draft },
      effects: [{ type: 'persistDraft', draft }]
    };
  }

  if (event.type === 'revisionReceived') {
    const revision = event.revision;
    if (revision.number < state.revision.number) {
      return { state, effects: [] };
    }
    if (revision.number === state.revision.number) {
      return revision.text === state.revision.text
        ? { state, effects: [] }
        : { state, effects: [{ type: 'requestResync' }] };
    }
    if (state.pendingChange !== null && revision.text === state.pendingChange.text) {
      if (state.draft !== null && state.draft.text !== state.pendingChange.text) {
        const draft = { baseRevision: revision.number, text: state.draft.text };
        const pendingChange = { ...draft };
        return {
          state: { ...state, revision, draft, pendingChange },
          effects: [
            { type: 'persistDraft', draft },
            { type: 'submitChange', change: pendingChange }
          ]
        };
      }
      return {
        state: {
          ...state,
          revision,
          draft: null,
          pendingChange: null,
          savePhase: state.savePhase === 'awaiting-change' ? 'saving' : state.savePhase,
          savingRevision: state.savePhase === 'awaiting-change' ? revision : state.savingRevision
        },
        effects: state.savePhase === 'awaiting-change'
          ? [
              { type: 'persistDraft', draft: null },
              { type: 'saveRevision', revision }
            ]
          : [{ type: 'persistDraft', draft: null }]
      };
    }
    const rebasedText = reconcileDraft(state.revision.text, state.draft?.text ?? null, revision.text);
    if (rebasedText === null) {
      const effects: DocumentSessionEffect[] = [];
      if (state.draft !== null || state.pendingChange !== null) {
        effects.push({ type: 'persistDraft', draft: null });
      }
      effects.push({ type: 'presentText', text: revision.text, source: 'revision' });
      if (state.savePhase === 'awaiting-change') {
        effects.push({ type: 'saveRevision', revision });
      }
      return {
        state: {
          ...state,
          revision,
          draft: null,
          pendingChange: null,
          savePhase: state.savePhase === 'awaiting-change' ? 'saving' : state.savePhase,
          savingRevision: state.savePhase === 'awaiting-change' ? revision : state.savingRevision
        },
        effects
      };
    }
    const draft = { baseRevision: revision.number, text: rebasedText };
    const pendingChange = { ...draft };
    return {
      state: { ...state, revision, draft, pendingChange },
      effects: [
        { type: 'persistDraft', draft },
        { type: 'presentText', text: draft.text, source: 'rebased-draft' },
        { type: 'submitChange', change: pendingChange }
      ]
    };
  }

  if (event.type === 'saveRequested') {
    if (state.savePhase !== 'idle') return { state, effects: [] };
    if (state.pendingChange !== null) {
      return { state: { ...state, savePhase: 'awaiting-change' }, effects: [] };
    }
    if (state.draft !== null) {
      const pendingChange = { baseRevision: state.revision.number, text: state.draft.text };
      return {
        state: { ...state, pendingChange, savePhase: 'awaiting-change' },
        effects: [{ type: 'submitChange', change: pendingChange }]
      };
    }
    return {
      state: { ...state, savePhase: 'saving', savingRevision: state.revision },
      effects: [{ type: 'saveRevision', revision: state.revision }]
    };
  }

  if (event.type === 'saveCompleted') {
    if (state.savePhase !== 'saving' || state.savingRevision === null
      || event.revision.number !== state.savingRevision.number
      || event.revision.text !== state.savingRevision.text) {
      return { state, effects: [] };
    }
    const previousSavedNumber = state.savedRevision?.revisionNumber;
    const savedRevision = typeof previousSavedNumber === 'number'
      && previousSavedNumber > event.revision.number
      ? state.savedRevision
      : { revisionNumber: event.revision.number, text: event.revision.text };
    return {
      state: { ...state, savedRevision, savePhase: 'idle', savingRevision: null },
      effects: []
    };
  }

  if (event.type === 'saveFailed') {
    return state.savePhase !== 'saving'
      || state.savingRevision === null
      || event.revision.number !== state.savingRevision.number
      || event.revision.text !== state.savingRevision.text
      ? { state, effects: [] }
      : { state: { ...state, savePhase: 'idle', savingRevision: null }, effects: [] };
  }

  if (event.type === 'reloadedFromDisk') {
    if (event.revision.number < state.revision.number) return { state, effects: [] };
    if (event.revision.number === state.revision.number
      && event.revision.text !== state.revision.text) {
      return { state, effects: [{ type: 'requestResync' }] };
    }
    return {
      state: {
        ...state,
        revision: event.revision,
        savedRevision: { revisionNumber: event.revision.number, text: event.revision.text },
        draft: null,
        pendingChange: null,
        savePhase: 'idle',
        savingRevision: null
      },
      effects: [
        { type: 'persistDraft', draft: null },
        { type: 'presentText', text: event.revision.text, source: 'disk-reload' }
      ]
    };
  }

  if (state.draft === null || state.pendingChange !== null) {
    return { state, effects: [] };
  }
  const pendingChange = { baseRevision: state.revision.number, text: state.draft.text };
  return {
    state: { ...state, pendingChange },
    effects: [{ type: 'submitChange', change: pendingChange }]
  };
}

type TextChange = {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
};

function reconcileDraft(baseText: string, draftText: string | null, incomingText: string): string | null {
  if (draftText === null || draftText === baseText || draftText === incomingText) return null;
  const draftChange = findTextChange(baseText, draftText);
  const incomingChange = findTextChange(baseText, incomingText);
  if (draftChange === null || incomingChange === null || changesOverlap(draftChange, incomingChange)) return null;

  const incomingDelta = incomingChange.insert.length - (incomingChange.to - incomingChange.from);
  const draftFrom = incomingChange.to <= draftChange.from ? draftChange.from + incomingDelta : draftChange.from;
  const draftTo = incomingChange.to <= draftChange.from ? draftChange.to + incomingDelta : draftChange.to;
  return incomingText.slice(0, draftFrom) + draftChange.insert + incomingText.slice(draftTo);
}

function findTextChange(previousText: string, nextText: string): TextChange | null {
  if (previousText === nextText) return null;
  let from = 0;
  const maxStart = Math.min(previousText.length, nextText.length);
  while (from < maxStart && previousText.charCodeAt(from) === nextText.charCodeAt(from)) from += 1;

  let previousTo = previousText.length;
  let nextTo = nextText.length;
  while (previousTo > from && nextTo > from
    && previousText.charCodeAt(previousTo - 1) === nextText.charCodeAt(nextTo - 1)) {
    previousTo -= 1;
    nextTo -= 1;
  }
  return { from, to: previousTo, insert: nextText.slice(from, nextTo) };
}

function changesOverlap(left: TextChange, right: TextChange): boolean {
  if (left.from === left.to && right.from === right.to) return left.from === right.from;
  return left.from < right.to && right.from < left.to;
}
