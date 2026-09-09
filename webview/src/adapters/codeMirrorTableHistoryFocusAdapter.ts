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

const restoreTableHistoryFocusEffect = StateEffect.define<TableHistoryFocusTarget>({
  map: mapTarget
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
        next = effect.value;
        found = true;
      }
      if (found) return next;
      return transaction.docChanged ? null : value;
    }
  });

  const historyExtension = invertedEffects.of((transaction) => (
    transaction.effects
      .filter((effect) => effect.is(restoreTableHistoryFocusEffect))
      .map((effect) => restoreTableHistoryFocusEffect.of(effect.value))
  ));

  let extension: Extension = [];
  const adapter: CodeMirrorTableHistoryFocus = {
    get extension() { return extension; },
    effect: (target) => restoreTableHistoryFocusEffect.of(target),
    read: (state) => state.field(stateField, false) ?? null
  };
  extension = [tableHistoryFocusFacet.of(adapter), stateField, historyExtension];
  return adapter;
}
