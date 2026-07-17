import {
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Transaction
} from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';

interface InsertedTableRowEffectValue {
  id: number;
  generation: number;
  at: number;
  assoc: -1 | 1;
  offset: number;
}

class InsertedTableRowValue extends RangeValue {
  constructor(readonly id: number) {
    super();
  }
}

let nextInsertedTableRowId = 1;
const mapInsertedTableRowEffect = (value: InsertedTableRowEffectValue, mapping: ChangeDesc) => ({
  ...value,
  at: mapping.mapPos(value.at, value.assoc)
});
const markInsertedTableRowEffect = StateEffect.define<InsertedTableRowEffectValue>({
  map: mapInsertedTableRowEffect
});
const removeInsertedTableRowEffect = StateEffect.define<InsertedTableRowEffectValue>({
  map: mapInsertedTableRowEffect
});
export const clearInsertedTableRowsEffect = StateEffect.define<null>();

interface InsertedTableRowsState {
  ranges: RangeSet<InsertedTableRowValue>;
  generation: number;
}

function replacedInsertedTableRows(
  ranges: RangeSet<InsertedTableRowValue>,
  generation: number,
  transaction: Transaction
): InsertedTableRowEffectValue[] {
  const replaced: InsertedTableRowEffectValue[] = [];
  ranges.between(0, transaction.startState.doc.length, (rowFrom, rowTo, row) => {
    transaction.changes.iterChanges((fromA, toA, fromB) => {
      if (toA <= fromA || fromA > rowFrom || toA < rowTo) return;
      replaced.push({
        id: row.id,
        generation,
        at: fromB,
        assoc: -1,
        offset: rowFrom - fromA
      });
    });
  });
  return replaced;
}

export const insertedTableRowsField = StateField.define<InsertedTableRowsState>({
  create() {
    return { ranges: RangeSet.empty, generation: 0 };
  },
  update(value, transaction) {
    if (transaction.effects.some((effect) => effect.is(clearInsertedTableRowsEffect))) {
      return { ranges: RangeSet.empty, generation: value.generation + 1 };
    }

    const replacedRows = replacedInsertedTableRows(value.ranges, value.generation, transaction);
    const removedIds = new Set([
      ...replacedRows.map(({ id }) => id),
      ...transaction.effects
        .filter((effect) => effect.is(removeInsertedTableRowEffect) && effect.value.generation === value.generation)
        .map((effect) => effect.value.id)
    ]);
    let ranges = value.ranges.map(transaction.changes).update({
      filter: (from, to, row) => from < to && !removedIds.has(row.id)
    });
    const additions = transaction.effects
      .filter((effect) => effect.is(markInsertedTableRowEffect) && effect.value.generation === value.generation)
      .map((effect) => {
        const position = transaction.changes.mapPos(effect.value.at, effect.value.assoc) + effect.value.offset;
        const line = transaction.newDoc.lineAt(Math.max(0, Math.min(position, transaction.newDoc.length)));
        return new InsertedTableRowValue(effect.value.id).range(line.from, line.to);
      });
    if (additions.length) {
      ranges = ranges.update({ add: additions, sort: true });
    }
    return { ranges, generation: value.generation };
  }
});

export function createMarkInsertedTableRowEffect(
  state: EditorState,
  at: number,
  assoc: -1 | 1,
  offset = 0
) {
  const generation = state.field(insertedTableRowsField, false)?.generation ?? 0;
  return markInsertedTableRowEffect.of({
    id: nextInsertedTableRowId++,
    generation,
    at,
    assoc,
    offset
  });
}

export function getInsertedTableRowsInRange(state: EditorState, from: number, to: number) {
  const rows: Array<{ id: number; from: number; to: number }> = [];
  state.field(insertedTableRowsField, false)?.ranges.between(from, to, (rowFrom, rowTo, row) => {
    if (rowFrom >= from && rowTo <= to) {
      rows.push({ id: row.id, from: rowFrom, to: rowTo });
    }
  });
  return rows;
}

export function createRemapInsertedTableRowEffects(
  state: EditorState,
  tableFrom: number,
  mappings: Array<{ id: number; oldOffset: number; newOffset: number }>
) {
  const generation = state.field(insertedTableRowsField, false)?.generation ?? 0;
  return mappings.flatMap(({ id, oldOffset, newOffset }) => {
    const base = { id, generation, at: tableFrom, assoc: -1 as const };
    return [
      removeInsertedTableRowEffect.of({ ...base, offset: oldOffset }),
      markInsertedTableRowEffect.of({ ...base, offset: newOffset })
    ];
  });
}

export const insertedTableRowsHistoryExtension = invertedEffects.of((transaction) => {
  const effects: StateEffect<InsertedTableRowEffectValue>[] = [];
  for (const effect of transaction.effects) {
    if (effect.is(markInsertedTableRowEffect)) {
      effects.push(removeInsertedTableRowEffect.of(effect.value));
    } else if (effect.is(removeInsertedTableRowEffect)) {
      effects.push(markInsertedTableRowEffect.of(effect.value));
    }
  }
  const state = transaction.startState.field(insertedTableRowsField, false);
  if (state) {
    const explicitlyRemovedIds = new Set(
      transaction.effects
        .filter((effect) => effect.is(removeInsertedTableRowEffect))
        .map((effect) => effect.value.id)
    );
    for (const replacedRow of replacedInsertedTableRows(state.ranges, state.generation, transaction)) {
      if (!explicitlyRemovedIds.has(replacedRow.id)) {
        effects.push(markInsertedTableRowEffect.of(replacedRow));
      }
    }
  }
  return effects;
});
