import { equalDocumentText, isEmptyDocumentEdit, readDocumentText,
  type DocumentText, type DocumentTextChange, type DocumentTextEdit } from '../foundation/documentSnapshot';

export type Revision = {
  readonly number: number;
  readonly text: DocumentText;
};

export type Draft = {
  readonly baseRevision: number;
  readonly text: DocumentText;
  readonly edit?: DocumentTextEdit;
  /** A terminal external conflict keeps the original local base for recovery. */
  readonly conflictBaseText?: DocumentText;
};

export type Change = {
  readonly baseRevision: number;
  readonly text: DocumentText;
  readonly edit?: DocumentTextEdit;
};

export type SavedRevision = {
  readonly revisionNumber: number | null;
  readonly text: DocumentText;
};

export type DocumentPresentationSource = 'revision' | 'rebased-draft' | 'disk-reload';

export type DocumentPresentationCompletion = 'discard-draft-recovery';

export type DocumentSessionState = {
  readonly documentId: string;
  readonly revision: Revision;
  readonly savedRevision: SavedRevision | null;
  readonly draft: Draft | null;
  readonly pendingChange: Change | null;
  /** Suppresses replayed conflicts until the Draft context or accepted Revision changes. */
  readonly lastRejectedExternalRevision: Revision | null;
  readonly savePhase: 'idle' | 'awaiting-change' | 'saving';
  readonly savingRevision: Revision | null;
};

export type DocumentSessionEvent =
  | { readonly type: 'draftChanged'; readonly text: DocumentText; readonly edit?: DocumentTextEdit }
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
      readonly text: DocumentText;
      readonly source: DocumentPresentationSource;
      readonly onPresented?: DocumentPresentationCompletion;
    }
  | { readonly type: 'reportExternalConflict' }
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
    lastRejectedExternalRevision: null,
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
    const previousText = state.draft?.text ?? state.revision.text;
    const suppliedEdit = event.edit && equalDocumentText(event.edit.after, event.text) ? event.edit : undefined;
    const localEdit = suppliedEdit && equalDocumentText(suppliedEdit.before, previousText)
      ? suppliedEdit : undefined;
    const editRebase = localEdit || suppliedEdit === undefined
      ? null : rebaseDocumentEdit(suppliedEdit, previousText);
    const rebasedText = editRebase === null || editRebase.kind === 'conflict'
      ? null
      : editRebase.kind === 'merged' ? editRebase.text
        : reconcileDraft(suppliedEdit!.before, suppliedEdit!.after, previousText);
    if (suppliedEdit && !localEdit && !equalDocumentText(suppliedEdit.before, previousText)
      && rebasedText === null && !equalDocumentText(event.text, previousText)) {
      const draft: Draft = {
        baseRevision: state.revision.number,
        text: event.text,
        conflictBaseText: suppliedEdit.before
      };
      return {
        state: { ...state, draft, lastRejectedExternalRevision: state.revision },
        effects: [{ type: 'persistDraft', draft }, { type: 'reportExternalConflict' }]
      };
    }
    const draftText = rebasedText ?? event.text;
    const edit = localEdit && (state.draft === null ? localEdit
      : state.draft.edit?.compose(localEdit));
    if (state.pendingChange === null && (edit ? isEmptyDocumentEdit(edit) : equalDocumentText(draftText, state.revision.text))) {
      if (state.draft === null) {
        return state.lastRejectedExternalRevision === null
          ? { state, effects: [] }
          : {
              state: { ...state, lastRejectedExternalRevision: null },
              effects: []
            };
      }
      return {
        state: { ...state, draft: null, lastRejectedExternalRevision: null },
        effects: [{ type: 'persistDraft', draft: null }]
      };
    }
    const draft: Draft = {
      baseRevision: state.revision.number,
      text: draftText,
      ...(edit ? { edit } : {}),
      ...(state.draft?.conflictBaseText !== undefined ? { conflictBaseText: state.draft.conflictBaseText } : {})
    };
    return {
      state: { ...state, draft, lastRejectedExternalRevision: null },
      effects: [
        { type: 'persistDraft', draft },
        ...(rebasedText === null ? [] : [{ type: 'presentText' as const, text: draft.text, source: 'rebased-draft' as const }])
      ]
    };
  }

  if (event.type === 'revisionReceived') {
    const revision = event.revision;
    if (revision.number < state.revision.number) {
      return { state, effects: [] };
    }
    if (state.lastRejectedExternalRevision !== null
      && revision.number < state.lastRejectedExternalRevision.number) {
      return { state, effects: [] };
    }
    if (revision.number === state.revision.number) {
      return equalDocumentText(revision.text, state.revision.text)
        ? { state, effects: [] }
        : { state, effects: [{ type: 'requestResync' }] };
    }
    if (state.pendingChange !== null && equalDocumentText(revision.text, state.pendingChange.text)) {
      if (state.draft !== null && !equalDocumentText(state.draft.text, state.pendingChange.text)) {
        const edit = state.pendingChange.edit && state.draft.edit
          ? state.pendingChange.edit.invert().compose(state.draft.edit) : undefined;
        const draft = { baseRevision: revision.number, text: state.draft.text, ...(edit ? { edit } : {}) };
        const pendingChange = { ...draft };
        return {
          state: {
            ...state,
            revision,
            draft,
            pendingChange,
            lastRejectedExternalRevision: null
          },
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
          lastRejectedExternalRevision: null,
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
    const editRebase = state.draft?.edit === undefined
      ? null : rebaseDocumentEdit(state.draft.edit, revision.text);
    const rebasedText = editRebase === null || editRebase.kind === 'unavailable'
      ? reconcileDraft(state.revision.text, state.draft?.text ?? null, revision.text)
      : editRebase.kind === 'merged' ? editRebase.text : null;
    if (rebasedText === null
      && state.draft !== null
      && !equalDocumentText(state.draft.text, revision.text)) {
      if (state.lastRejectedExternalRevision?.number === revision.number
        && equalDocumentText(state.lastRejectedExternalRevision.text, revision.text)) {
        return { state, effects: [] };
      }
      const draft: Draft = { ...state.draft, conflictBaseText: state.revision.text };
      return {
        state: { ...state, draft, lastRejectedExternalRevision: revision },
        effects: [{ type: 'persistDraft', draft }, { type: 'reportExternalConflict' }]
      };
    }
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
          lastRejectedExternalRevision: null,
          savePhase: state.savePhase === 'awaiting-change' ? 'saving' : state.savePhase,
          savingRevision: state.savePhase === 'awaiting-change' ? revision : state.savingRevision
        },
        effects
      };
    }
    const draft = { baseRevision: revision.number, text: rebasedText };
    const pendingChange = { ...draft };
    return {
      state: {
        ...state,
        revision,
        draft,
        pendingChange,
        lastRejectedExternalRevision: null
      },
      effects: [
        { type: 'persistDraft', draft },
        { type: 'presentText', text: draft.text, source: 'rebased-draft' },
        { type: 'submitChange', change: pendingChange }
      ]
    };
  }

  if (event.type === 'saveRequested') {
    if (state.savePhase !== 'idle') return { state, effects: [] };
    if (state.draft?.conflictBaseText !== undefined) return { state, effects: [{ type: 'reportExternalConflict' }] };
    if (state.pendingChange !== null) {
      return { state: { ...state, savePhase: 'awaiting-change' }, effects: [] };
    }
    if (state.draft !== null) {
      const pendingChange = { ...state.draft };
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
      || !equalDocumentText(event.revision.text, state.savingRevision.text)) {
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
      || !equalDocumentText(event.revision.text, state.savingRevision.text)
      ? { state, effects: [] }
      : { state: { ...state, savePhase: 'idle', savingRevision: null }, effects: [] };
  }

  if (event.type === 'reloadedFromDisk') {
    if (event.revision.number < state.revision.number) return { state, effects: [] };
    if (event.revision.number === state.revision.number
      && !equalDocumentText(event.revision.text, state.revision.text)) {
      return { state, effects: [{ type: 'requestResync' }] };
    }
    return {
      state: {
        ...state,
        revision: event.revision,
        savedRevision: { revisionNumber: event.revision.number, text: event.revision.text },
        draft: null,
        pendingChange: null,
        lastRejectedExternalRevision: null,
        savePhase: 'idle',
        savingRevision: null
      },
      effects: [
        {
          type: 'presentText',
          text: event.revision.text,
          source: 'disk-reload',
          onPresented: 'discard-draft-recovery'
        }
      ]
    };
  }

  if (state.draft === null || state.pendingChange !== null || state.draft.conflictBaseText !== undefined) {
    return { state, effects: [] };
  }
  const pendingChange = { ...state.draft };
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

type EditRebase =
  | { readonly kind: 'merged'; readonly text: DocumentText }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'unavailable' };

/**
 * Replays the concrete transaction ranges only when a Host revision has
 * crossed the local edit. Normal local input keeps its existing hot path.
 */
function rebaseDocumentEdit(edit: DocumentTextEdit, incomingText: DocumentText): EditRebase {
  if (!isReplayableDocumentEdit(edit)) return { kind: 'unavailable' };
  if (equalDocumentText(edit.after, incomingText)) return { kind: 'merged', text: incomingText };

  const incomingChange = findTextChange(readDocumentText(edit.before), readDocumentText(incomingText));
  if (incomingChange === null) {
    return { kind: 'merged', text: applyTextChanges(incomingText, edit.changes) };
  }

  const delta = incomingChange.insert.length - (incomingChange.to - incomingChange.from);
  const rebasedChanges: TextChange[] = [];
  for (const change of edit.changes) {
    if (changesOverlap(change, incomingChange)) return { kind: 'conflict' };
    const shifted = incomingChange.to <= change.from;
    rebasedChanges.push({
      from: change.from + (shifted ? delta : 0),
      to: change.to + (shifted ? delta : 0),
      insert: change.insert
    });
  }
  return { kind: 'merged', text: applyTextChanges(incomingText, rebasedChanges) };
}

/** Real edit ranges must describe their recorded before/after transaction. */
function isReplayableDocumentEdit(edit: DocumentTextEdit): boolean {
  return edit.changes.every(change => (
    change.from >= 0 && change.to >= change.from && change.to <= edit.before.length
  )) && equalDocumentText(applyTextChanges(edit.before, edit.changes), edit.after);
}

/**
 * Changes are in their common before-coordinate space. Apply right-to-left;
 * retaining the original right-to-left order keeps adjacent ranges stable when
 * a Host deletion collapses their boundaries to one position.
 */
function applyTextChanges(text: DocumentText, changes: readonly DocumentTextChange[]): DocumentText {
  let result = text;
  const ordered = changes.map((change, index) => ({ change, index })).sort((left, right) => (
    right.change.from - left.change.from
      || right.change.to - left.change.to
      || right.index - left.index
 ));
  for (const { change } of ordered) {
    result = typeof result === 'string'
      ? result.slice(0, change.from) + change.insert + result.slice(change.to)
      : result.replace(change.from, change.to, change.insert);
  }
  return result;
}

function reconcileDraft(baseText: DocumentText, draftText: DocumentText | null, incomingText: DocumentText): DocumentText | null {
  if (draftText === null || equalDocumentText(draftText, baseText) || equalDocumentText(draftText, incomingText)) return null;
  const draftChange = findTextChange(readDocumentText(baseText), readDocumentText(draftText));
  const incomingChange = findTextChange(readDocumentText(baseText), readDocumentText(incomingText));
  if (draftChange === null || incomingChange === null || changesOverlap(draftChange, incomingChange)) return null;

  const incomingDelta = incomingChange.insert.length - (incomingChange.to - incomingChange.from);
  const draftFrom = incomingChange.to <= draftChange.from ? draftChange.from + incomingDelta : draftChange.from;
  const draftTo = incomingChange.to <= draftChange.from ? draftChange.to + incomingDelta : draftChange.to;
  return typeof incomingText === 'string'
    ? incomingText.slice(0, draftFrom) + draftChange.insert + incomingText.slice(draftTo)
    : incomingText.replace(draftFrom, draftTo, draftChange.insert);
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
  if (left.from === left.to) return right.from < left.from && left.from < right.to;
  if (right.from === right.to) return left.from < right.from && right.from < left.to;
  return left.from < right.to && right.from < left.to;
}
