import { StateEffect, StateField, type EditorSelection, type EditorState } from '@codemirror/state';

type LivePointerSelectionState = {
  active: boolean;
  preservedLine: number | null;
  awaitingSelection?: true;
  presentationSelection: EditorSelection | null;
};

export const setLivePointerSelectionActiveEffect = StateEffect.define<{
  active: boolean;
  preservedLine: number | null;
  awaitingSelection?: true;
}>();

// The document selection remains native. Only presentation waits for release,
// so a shrinking source/preview cannot move text underneath a held pointer.
export const livePointerSelectionActiveField = StateField.define<LivePointerSelectionState>({
  create: () => ({ active: false, preservedLine: null, presentationSelection: null }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLivePointerSelectionActiveEffect)) {
        return { ...effect.value, presentationSelection: effect.value.active ? transaction.startState.selection : null };
      }
    }
    if (value.awaitingSelection && transaction.selection) return {
      active: value.active, preservedLine: value.preservedLine,
      presentationSelection: value.presentationSelection && transaction.docChanged
        ? value.presentationSelection.map(transaction.changes) : value.presentationSelection
    };
    return value.presentationSelection && transaction.docChanged
      ? { ...value, presentationSelection: value.presentationSelection.map(transaction.changes) } : value;
  }
});

export function sourcePresentationSelection(state: EditorState): EditorSelection {
  return state.field(livePointerSelectionActiveField, false)?.presentationSelection ?? state.selection;
}

export function isLivePointerSelectionActive(state: EditorState): boolean {
  return state.field(livePointerSelectionActiveField, false)?.active ?? false;
}
