import { invertedEffects } from '@codemirror/commands';
import { EditorSelection, StateEffect, StateField, type ChangeDesc, type Extension, type EditorState } from '@codemirror/state';

export type HistorySelection = {
  readonly ranges: readonly { readonly anchor: number; readonly head: number }[];
  readonly mainIndex: number;
};

type HistorySelectionPair = {
  target: HistorySelection | null;
  inverse: HistorySelection | null;
  explicit: boolean;
};

type HistorySelectionTarget = { selection: HistorySelection | null; explicit: boolean };

export function mapHistorySelection(selection: HistorySelection, mapping: ChangeDesc): HistorySelection {
  const mapped = EditorSelection.create(selection.ranges.map(range =>
    EditorSelection.range(range.anchor, range.head)), selection.mainIndex).map(mapping);
  return {
    ranges: mapped.ranges.map(range => ({ anchor: range.anchor, head: range.head })),
    mainIndex: mapped.mainIndex
  };
}

export function isHistorySelectionValid(selection: HistorySelection | null, documentLength: number): selection is HistorySelection {
  return selection !== null
    && Number.isInteger(selection.mainIndex)
    && selection.mainIndex >= 0 && selection.mainIndex < selection.ranges.length
    && selection.ranges.every(range => Number.isInteger(range.anchor) && Number.isInteger(range.head)
      && range.anchor >= 0 && range.anchor <= documentLength
      && range.head >= 0 && range.head <= documentLength);
}

const restoreHistorySelectionEffect = StateEffect.define<HistorySelectionPair>({
  map: (pair, mapping) => ({
    target: pair.target ? mapHistorySelection(pair.target, mapping) : null,
    inverse: pair.inverse ? mapHistorySelection(pair.inverse, mapping) : null,
    explicit: pair.explicit
  })
});

function historySelection(selection: EditorSelection): HistorySelection {
  return {
    ranges: selection.ranges.map(range => ({ anchor: range.anchor, head: range.head })),
    mainIndex: selection.mainIndex
  };
}

/** Attaches semantic and formatter selections to their native history event. */
export function createCodeMirrorHistorySelectionAdapter(): {
  readonly extension: Extension;
  effect(target: HistorySelection | null, inverse?: HistorySelection | null): StateEffect<unknown>;
  read(state: EditorState): HistorySelection | null;
  readExplicit(state: EditorState): HistorySelection | null;
} {
  const stateField = StateField.define<HistorySelectionTarget | null>({
    create: () => null,
    update(value, transaction) {
      // A composed transaction may carry several semantic targets. Its final
      // replacement owns the visible selection, matching CodeMirror's final
      // document and selection rather than an earlier stale target.
      const effect = transaction.effects.filter(effect => effect.is(restoreHistorySelectionEffect)).at(-1);
      if (effect) return { selection: effect.value.target, explicit: effect.value.explicit };
      return transaction.docChanged || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') ? null : value;
    }
  });

  const historyExtension = invertedEffects.of(transaction => (
    transaction.effects.some(effect => effect.is(restoreHistorySelectionEffect))
      ? transaction.effects
      .filter(effect => effect.is(restoreHistorySelectionEffect))
      .map(effect => restoreHistorySelectionEffect.of({
        // StateEffect.map already follows intervening document changes while
        // the history branch is rebased. These are complete selections on the
        // two sides of this transaction, so mapping through the just-inverted
        // change again would shift redo's next match twice.
        target: effect.value.inverse,
        inverse: effect.value.target,
        explicit: effect.value.explicit
      }))
      : transaction.docChanged && transaction.isUserEvent('input.format')
        ? [restoreHistorySelectionEffect.of({
          target: historySelection(transaction.startState.selection),
          inverse: historySelection(transaction.newSelection),
          explicit: false
        })]
        : []
  ));

  const adapter = {
    extension: [] as Extension,
    effect: (target: HistorySelection | null, inverse: HistorySelection | null = target) =>
      restoreHistorySelectionEffect.of({ target, inverse, explicit: true }),
    read: (state: EditorState) => state.field(stateField, false)?.selection ?? null,
    readExplicit: (state: EditorState) => {
      const target = state.field(stateField, false);
      return target?.explicit ? target.selection : null;
    }
  };
  adapter.extension = [stateField, historyExtension];
  return adapter;
}
