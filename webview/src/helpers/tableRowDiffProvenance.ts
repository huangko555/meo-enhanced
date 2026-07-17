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

interface DeletedTableRowsEffectValue {
  id: number;
  generation: number;
  at: number;
  assoc: -1 | 1;
  baselineRanges: Array<[number, number]>;
  deletionAtEnd: boolean;
}

class InsertedTableRowValue extends RangeValue {
  constructor(readonly id: number) {
    super();
  }
}

export interface DeletedTableRowsRecord {
  id: number;
  at: number;
  baselineRanges: Array<[number, number]>;
  deletionAtEnd: boolean;
}

interface TableRowDiffProvenanceState {
  insertedRanges: RangeSet<InsertedTableRowValue>;
  deletedRows: DeletedTableRowsRecord[];
  generation: number;
}

let nextTableRowProvenanceId = 1;
const mapInsertedTableRowEffect = (value: InsertedTableRowEffectValue, mapping: ChangeDesc) => ({
  ...value,
  at: mapping.mapPos(value.at, value.assoc)
});
const mapDeletedTableRowsEffect = (value: DeletedTableRowsEffectValue, mapping: ChangeDesc) => ({
  ...value,
  at: mapping.mapPos(value.at, value.assoc)
});
const markInsertedTableRowEffect = StateEffect.define<InsertedTableRowEffectValue>({
  map: mapInsertedTableRowEffect
});
const removeInsertedTableRowEffect = StateEffect.define<InsertedTableRowEffectValue>({
  map: mapInsertedTableRowEffect
});
const markDeletedTableRowsEffect = StateEffect.define<DeletedTableRowsEffectValue>({
  map: mapDeletedTableRowsEffect
});
const removeDeletedTableRowsEffect = StateEffect.define<DeletedTableRowsEffectValue>({
  map: mapDeletedTableRowsEffect
});
export const clearTableRowDiffProvenanceEffect = StateEffect.define<null>();

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

export const tableRowDiffProvenanceField = StateField.define<TableRowDiffProvenanceState>({
  create() {
    return { insertedRanges: RangeSet.empty, deletedRows: [], generation: 0 };
  },
  update(value, transaction) {
    if (transaction.effects.some((effect) => effect.is(clearTableRowDiffProvenanceEffect))) {
      return { insertedRanges: RangeSet.empty, deletedRows: [], generation: value.generation + 1 };
    }

    const replacedRows = replacedInsertedTableRows(value.insertedRanges, value.generation, transaction);
    const removedInsertedIds = new Set([
      ...replacedRows.map(({ id }) => id),
      ...transaction.effects
        .filter((effect) => effect.is(removeInsertedTableRowEffect) && effect.value.generation === value.generation)
        .map((effect) => effect.value.id)
    ]);
    let insertedRanges = value.insertedRanges.map(transaction.changes).update({
      filter: (from, to, row) => from < to && !removedInsertedIds.has(row.id)
    });
    const insertedAdditions = transaction.effects
      .filter((effect) => effect.is(markInsertedTableRowEffect) && effect.value.generation === value.generation)
      .map((effect) => {
        const position = transaction.changes.mapPos(effect.value.at, effect.value.assoc) + effect.value.offset;
        const line = transaction.newDoc.lineAt(Math.max(0, Math.min(position, transaction.newDoc.length)));
        return new InsertedTableRowValue(effect.value.id).range(line.from, line.to);
      });
    if (insertedAdditions.length) {
      insertedRanges = insertedRanges.update({ add: insertedAdditions, sort: true });
    }

    const removedDeletedIds = new Set(
      transaction.effects
        .filter((effect) => effect.is(removeDeletedTableRowsEffect) && effect.value.generation === value.generation)
        .map((effect) => effect.value.id)
    );
    const deletedRows = value.deletedRows
      .filter((record) => !removedDeletedIds.has(record.id))
      .map((record) => ({
        ...record,
        at: transaction.changes.mapPos(record.at, record.deletionAtEnd ? -1 : 1)
      }));
    for (const effect of transaction.effects) {
      if (!effect.is(markDeletedTableRowsEffect) || effect.value.generation !== value.generation) continue;
      deletedRows.push({
        id: effect.value.id,
        at: transaction.changes.mapPos(effect.value.at, effect.value.assoc),
        baselineRanges: effect.value.baselineRanges.map(([from, to]) => [from, to]),
        deletionAtEnd: effect.value.deletionAtEnd
      });
    }

    return { insertedRanges, deletedRows, generation: value.generation };
  }
});

export function createMarkInsertedTableRowEffect(
  state: EditorState,
  at: number,
  assoc: -1 | 1,
  offset = 0
) {
  const generation = state.field(tableRowDiffProvenanceField, false)?.generation ?? 0;
  return markInsertedTableRowEffect.of({
    id: nextTableRowProvenanceId++,
    generation,
    at,
    assoc,
    offset
  });
}

export function createMarkDeletedTableRowsEffect(
  state: EditorState,
  at: number,
  assoc: -1 | 1,
  baselineRanges: Array<[number, number]>,
  deletionAtEnd: boolean
) {
  const generation = state.field(tableRowDiffProvenanceField, false)?.generation ?? 0;
  return markDeletedTableRowsEffect.of({
    id: nextTableRowProvenanceId++,
    generation,
    at,
    assoc,
    baselineRanges,
    deletionAtEnd
  });
}

export function getInsertedTableRowsInRange(state: EditorState, from: number, to: number) {
  const rows: Array<{ id: number; from: number; to: number }> = [];
  state.field(tableRowDiffProvenanceField, false)?.insertedRanges.between(from, to, (rowFrom, rowTo, row) => {
    if (rowFrom >= from && rowTo <= to) {
      rows.push({ id: row.id, from: rowFrom, to: rowTo });
    }
  });
  return rows;
}

export function getDeletedTableRows(state: EditorState): DeletedTableRowsRecord[] {
  return state.field(tableRowDiffProvenanceField, false)?.deletedRows ?? [];
}

export function createRemapInsertedTableRowEffects(
  state: EditorState,
  tableFrom: number,
  mappings: Array<{ id: number; oldOffset: number; newOffset: number }>
) {
  const generation = state.field(tableRowDiffProvenanceField, false)?.generation ?? 0;
  return mappings.flatMap(({ id, oldOffset, newOffset }) => {
    const base = { id, generation, at: tableFrom, assoc: -1 as const };
    return [
      removeInsertedTableRowEffect.of({ ...base, offset: oldOffset }),
      markInsertedTableRowEffect.of({ ...base, offset: newOffset })
    ];
  });
}

export const tableRowDiffProvenanceHistoryExtension = invertedEffects.of((transaction) => {
  const effects: StateEffect<unknown>[] = [];
  for (const effect of transaction.effects) {
    if (effect.is(markInsertedTableRowEffect)) {
      effects.push(removeInsertedTableRowEffect.of(effect.value));
    } else if (effect.is(removeInsertedTableRowEffect)) {
      effects.push(markInsertedTableRowEffect.of(effect.value));
    } else if (effect.is(markDeletedTableRowsEffect)) {
      effects.push(removeDeletedTableRowsEffect.of(effect.value));
    } else if (effect.is(removeDeletedTableRowsEffect)) {
      effects.push(markDeletedTableRowsEffect.of(effect.value));
    }
  }
  const state = transaction.startState.field(tableRowDiffProvenanceField, false);
  if (state) {
    const explicitlyRemovedIds = new Set(
      transaction.effects
        .filter((effect) => effect.is(removeInsertedTableRowEffect))
        .map((effect) => effect.value.id)
    );
    for (const replacedRow of replacedInsertedTableRows(state.insertedRanges, state.generation, transaction)) {
      if (!explicitlyRemovedIds.has(replacedRow.id)) {
        effects.push(markInsertedTableRowEffect.of(replacedRow));
      }
    }
  }
  return effects;
});
