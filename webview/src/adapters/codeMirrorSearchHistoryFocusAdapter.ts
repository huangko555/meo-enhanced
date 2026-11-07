import { invertedEffects } from '@codemirror/commands';
import { EditorSelection, StateEffect, StateField, type ChangeDesc, type Extension, type EditorState } from '@codemirror/state';

export type SearchHistorySelection = {
  readonly ranges: readonly { readonly anchor: number; readonly head: number }[];
  readonly mainIndex: number;
};

type HistoryFocusPair = { target: SearchHistorySelection | null; inverse: SearchHistorySelection | null };

export function mapSearchHistorySelection(selection: SearchHistorySelection, mapping: ChangeDesc): SearchHistorySelection {
  const mapped = EditorSelection.create(selection.ranges.map(range =>
    EditorSelection.range(range.anchor, range.head)), selection.mainIndex).map(mapping);
  return {
    ranges: mapped.ranges.map(range => ({ anchor: range.anchor, head: range.head })),
    mainIndex: mapped.mainIndex
  };
}

export function isSearchHistorySelectionValid(selection: SearchHistorySelection | null, documentLength: number): selection is SearchHistorySelection {
  return selection !== null
    && Number.isInteger(selection.mainIndex)
    && selection.mainIndex >= 0 && selection.mainIndex < selection.ranges.length
    && selection.ranges.every(range => Number.isInteger(range.anchor) && Number.isInteger(range.head)
      && range.anchor >= 0 && range.anchor <= documentLength
      && range.head >= 0 && range.head <= documentLength);
}

const restoreSearchHistoryFocusEffect = StateEffect.define<HistoryFocusPair>({
  map: (pair, mapping) => ({
    target: pair.target ? mapSearchHistorySelection(pair.target, mapping) : null,
    inverse: pair.inverse ? mapSearchHistorySelection(pair.inverse, mapping) : null
  })
});

/** Keeps replace-current's next-match selection in the same native history event. */
export function createCodeMirrorSearchHistoryFocusAdapter(): {
  readonly extension: Extension;
  effect(target: SearchHistorySelection | null, inverse?: SearchHistorySelection | null): StateEffect<unknown>;
  read(state: EditorState): SearchHistorySelection | null;
} {
  const stateField = StateField.define<SearchHistorySelection | null>({
    create: () => null,
    update(value, transaction) {
      // A composed transaction may carry several semantic targets. Its final
      // replacement owns the visible selection, matching CodeMirror's final
      // document and selection rather than an earlier stale target.
      const effect = transaction.effects.filter(effect => effect.is(restoreSearchHistoryFocusEffect)).at(-1);
      if (effect) return effect.value.target;
      return transaction.docChanged || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') ? null : value;
    }
  });

  const historyExtension = invertedEffects.of(transaction => (
    transaction.effects
      .filter(effect => effect.is(restoreSearchHistoryFocusEffect))
      .map(effect => restoreSearchHistoryFocusEffect.of({
        // StateEffect.map already follows intervening document changes while
        // the history branch is rebased. These are complete selections on the
        // two sides of this transaction, so mapping through the just-inverted
        // change again would shift redo's next match twice.
        target: effect.value.inverse,
        inverse: effect.value.target
      }))
  ));

  const adapter = {
    extension: [] as Extension,
    effect: (target: SearchHistorySelection | null, inverse: SearchHistorySelection | null = target) =>
      restoreSearchHistoryFocusEffect.of({ target, inverse }),
    read: (state: EditorState) => state.field(stateField, false) ?? null
  };
  adapter.extension = [stateField, historyExtension];
  return adapter;
}
