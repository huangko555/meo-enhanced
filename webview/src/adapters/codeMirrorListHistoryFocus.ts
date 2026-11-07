import { invertedEffects } from '@codemirror/commands';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';

type ListHistoryTarget = {
  readonly lineFrom: number;
  readonly offset: number;
  readonly inverseOffset: number;
  readonly preserveSelection?: boolean;
};

// Offsets belong to the two sides of the same operation. Only the line identity
// is mapped through intervening changes; a removed prefix is not a live range.
const listHistoryTarget = StateEffect.define<ListHistoryTarget>({
  map: (target, mapping) => ({ ...target, lineFrom: mapping.mapPos(target.lineFrom, -1) })
});

const replayTarget = StateField.define<{ position: number; preserveSelection: boolean } | null>({
  create: () => null,
  update(value, transaction) {
    if (!transaction.isUserEvent('undo') && !transaction.isUserEvent('redo')) return transaction.docChanged ? null : value;
    const effect = transaction.effects.find(effect => effect.is(listHistoryTarget));
    return effect ? { position: Math.min(transaction.newDoc.length, effect.value.lineFrom + effect.value.offset),
      preserveSelection: effect.value.preserveSelection === true } : null;
  }
});

/** Semantic position travels in CodeMirror's native history, never a second stack. */
export const listHistoryFocus: Extension = [
  replayTarget,
  EditorState.transactionExtender.of(transaction => {
    if (!transaction.docChanged || !transaction.isUserEvent('input.list')
      || transaction.effects.some(effect => effect.is(listHistoryTarget))
      || transaction.startState.selection.ranges.length !== 1 || !transaction.startState.selection.main.empty
      || transaction.newSelection.ranges.length !== 1 || !transaction.newSelection.main.empty) return null;
    const before = transaction.startState.selection.main.head;
    const from = transaction.startState.doc.lineAt(before).from;
    const lineFrom = transaction.changes.mapPos(from, -1);
    return { effects: listHistoryTarget.of({ lineFrom, offset: transaction.newSelection.main.head - lineFrom,
      inverseOffset: before - from }) };
  }),
  invertedEffects.of(transaction => transaction.effects.filter(effect => effect.is(listHistoryTarget)).map(effect =>
    listHistoryTarget.of({
      ...effect.value,
      lineFrom: transaction.changes.invertedDesc.mapPos(effect.value.lineFrom, -1),
      offset: effect.value.inverseOffset,
      inverseOffset: effect.value.offset
    })
  ))
];

export function listHistoryFocusEffect(lineFrom: number, before: number, after: number, preserveSelection = false): StateEffect<unknown> {
  return listHistoryTarget.of({ lineFrom, offset: after - lineFrom, inverseOffset: before - lineFrom, preserveSelection });
}

export function readListHistoryFocus(state: EditorState): { position: number; preserveSelection: boolean } | null {
  return state.field(replayTarget, false) ?? null;
}
