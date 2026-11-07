import { invertedEffects } from '@codemirror/commands';
import { StateEffect, StateField, type ChangeDesc, type Extension } from '@codemirror/state';
import {
  tableHistoryFocusFacet,
  type CodeMirrorTableHistoryFocus,
  type TableHistoryFocusTarget
} from './tableHistoryFocus';

const mapTarget = (
  target: TableHistoryFocusTarget,
  mapping: ChangeDesc
): TableHistoryFocusTarget => ({
  ...target,
  tableFrom: mapping.mapPos(target.tableFrom, -1)
});

type HistoryFocusPair = { target: TableHistoryFocusTarget | null; inverse: TableHistoryFocusTarget | null };
const restoreTableHistoryFocusEffect = StateEffect.define<HistoryFocusPair>({
  map: (pair, mapping) => ({ target: pair.target ? mapTarget(pair.target, mapping) : null,
    inverse: pair.inverse ? mapTarget(pair.inverse, mapping) : null })
});

/** Keeps semantic table focus in the same native CodeMirror history event as its document change. */
export function createCodeMirrorTableHistoryFocusAdapter(): CodeMirrorTableHistoryFocus {
  const stateField = StateField.define<TableHistoryFocusTarget | null>({
    create: () => null,
    update(value, transaction) {
      let next = value;
      let found = false;
      for (const effect of transaction.effects) {
        if (!effect.is(restoreTableHistoryFocusEffect)) continue;
        next = effect.value.target;
        found = true;
      }
      if (found) return next;
      return transaction.docChanged || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') ? null : value;
    }
  });

  const historyExtension = invertedEffects.of((transaction) => (
    transaction.effects
      .filter((effect) => effect.is(restoreTableHistoryFocusEffect))
      .map((effect) => restoreTableHistoryFocusEffect.of({
        target: effect.value.inverse ? mapTarget(effect.value.inverse, transaction.changes.invertedDesc) : null,
        inverse: effect.value.target
      }))
  ));

  let extension: Extension = [];
  const adapter: CodeMirrorTableHistoryFocus = {
    get extension() { return extension; },
    effect: (target, inverse = target) => restoreTableHistoryFocusEffect.of({ target, inverse }),
    read: (state) => state.field(stateField, false) ?? null,
    isHistoryEffect: (effect) => effect.is(restoreTableHistoryFocusEffect),
    isContentOnly: (transaction) => transaction.effects.some(effect => effect.is(restoreTableHistoryFocusEffect) && effect.value.target?.contentOnly === true)
  };
  extension = [tableHistoryFocusFacet.of(adapter), stateField, historyExtension];
  return adapter;
}
