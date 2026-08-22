import { invertedEffects } from '@codemirror/commands';
import {
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
  type Transaction
} from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import type {
  TableProvenanceMutation,
  TableTransactionProvenance,
  TableTransactionProvenanceSnapshot
} from '../application/tableTransactionProvenance';
import {
  tableTransactionProvenanceFacet,
  type CodeMirrorTableProvenanceIntent,
  type CodeMirrorTableTransactionProvenance
} from './tableTransactionProvenance';

export type CodeMirrorTableTransactionProvenanceAdapter = CodeMirrorTableTransactionProvenance;

type PositionedRowEffect = {
  readonly id: string;
  readonly scope: number;
  readonly at: number;
  readonly assoc: -1 | 1;
  readonly offset: number;
};

type AdapterEffectValue =
  | ({ readonly type: 'markInsertedRow' | 'removeInsertedRow' } & PositionedRowEffect)
  | ({
      readonly type: 'markDeletedRows' | 'removeDeletedRows';
      readonly baselineRanges: ReadonlyArray<readonly [number, number]>;
      readonly deletionAtEnd: boolean;
    } & PositionedRowEffect)
  | {
      readonly type: 'remapInsertedRows';
      readonly scope: number;
      readonly tableFrom: number;
      readonly rows: ReadonlyArray<{ readonly id: string; readonly oldOffset: number; readonly newOffset: number }>;
    }
  | { readonly type: 'baselineRefreshed' | 'externalDocumentPresented' };

const mapPositionedEffect = (value: PositionedRowEffect, mapping: ChangeDesc): PositionedRowEffect => ({
  ...value,
  at: mapping.mapPos(value.at, value.assoc)
});

const provenanceEffect = StateEffect.define<AdapterEffectValue>({
  map(value, mapping) {
    if (value.type === 'baselineRefreshed' || value.type === 'externalDocumentPresented') return value;
    if (value.type === 'remapInsertedRows') {
      return { ...value, tableFrom: mapping.mapPos(value.tableFrom, -1) };
    }
    if (!('at' in value)) return value;
    return mapPositionedEffect(value, mapping) as AdapterEffectValue;
  }
});

function normalizedChanges(transaction: Transaction) {
  const changes: Array<{ from: number; to: number; insertedLength: number }> = [];
  transaction.changes.iterChanges((fromA, toA, fromB, toB) => {
    changes.push({ from: fromA, to: toA, insertedLength: toB - fromB });
  });
  return changes;
}

function replacedInsertedRows(
  snapshot: TableTransactionProvenanceSnapshot,
  transaction: Transaction
): PositionedRowEffect[] {
  const replaced: PositionedRowEffect[] = [];
  for (const row of snapshot.insertedRows) {
    transaction.changes.iterChanges((fromA, toA, fromB) => {
      if (toA <= fromA || fromA > row.from || toA < row.to) return;
      replaced.push({
        id: row.id,
        scope: snapshot.scope,
        at: fromB,
        assoc: -1,
        offset: row.from - fromA
      });
    });
  }
  return replaced;
}

/**
 * Converts CodeMirror transactions and native history effects into the pure
 * provenance Interface. CodeMirror remains the only history owner.
 */
export function createCodeMirrorTableTransactionProvenanceAdapter(
  provenance: TableTransactionProvenance
): CodeMirrorTableTransactionProvenanceAdapter {
  let nextId = 1;

  const effect = (intent: CodeMirrorTableProvenanceIntent): StateEffect<unknown> => {
    if (intent.type === 'baselineRefreshed' || intent.type === 'externalDocumentPresented') {
      return provenanceEffect.of(intent);
    }
    const scope = provenance.snapshot().scope;
    if (intent.type === 'insertedRow') {
      return provenanceEffect.of({
        type: 'markInsertedRow',
        id: `row-${nextId++}`,
        scope,
        at: intent.at,
        assoc: intent.assoc,
        offset: intent.offset ?? 0
      });
    }
    if (intent.type === 'deletedRows') {
      return provenanceEffect.of({
        type: 'markDeletedRows',
        id: `deletion-${nextId++}`,
        scope,
        at: intent.at,
        assoc: intent.assoc,
        offset: 0,
        baselineRanges: intent.baselineRanges.map(([from, to]) => [from, to]),
        deletionAtEnd: intent.deletionAtEnd
      });
    }
    return provenanceEffect.of({
      type: 'remapInsertedRows',
      scope,
      tableFrom: intent.tableFrom,
      rows: intent.rows.map((row) => ({ ...row }))
    });
  };

  const applyTransaction = (transaction: Transaction): void => {
    const effects = transaction.effects
      .filter((candidate) => candidate.is(provenanceEffect))
      .map((candidate) => candidate.value);
    const reset = effects.find((value) => (
      value.type === 'baselineRefreshed' || value.type === 'externalDocumentPresented'
    ));
    if (reset?.type === 'baselineRefreshed') {
      provenance.accept({ type: 'baselineRefreshed' });
      return;
    }
    if (reset?.type === 'externalDocumentPresented') {
      provenance.accept({ type: 'externalDocumentPresented' });
      return;
    }

    const scope = provenance.snapshot().scope;
    const mutations: TableProvenanceMutation[] = [];
    // StateEffect values already use the final TransactionSpec coordinates.
    // Sequential filters map them; remapping the combined changes here would
    // apply text changes a second time and violate the CodeMirror contract.
    for (const value of effects) {
      if (!('scope' in value) || value.scope !== scope) continue;
      if (value.type === 'markInsertedRow') {
        const position = value.at + value.offset;
        const line = transaction.newDoc.lineAt(Math.max(0, Math.min(position, transaction.newDoc.length)));
        mutations.push({ type: 'markInsertedRow', id: value.id, from: line.from, to: line.to });
      } else if (value.type === 'removeInsertedRow') {
        mutations.push({ type: 'removeInsertedRow', id: value.id });
      } else if (value.type === 'markDeletedRows') {
        mutations.push({
          type: 'markDeletedRows',
          id: value.id,
          at: value.at,
          baselineRanges: value.baselineRanges,
          deletionAtEnd: value.deletionAtEnd
        });
      } else if (value.type === 'removeDeletedRows') {
        mutations.push({ type: 'removeDeletedRows', id: value.id });
      } else if (value.type === 'remapInsertedRows') {
        const tableFrom = value.tableFrom;
        mutations.push({
          type: 'remapInsertedRows',
          rows: value.rows.map(({ id, newOffset }) => {
            const position = Math.max(0, Math.min(tableFrom + newOffset, transaction.newDoc.length));
            const line = transaction.newDoc.lineAt(position);
            return { id, from: line.from, to: line.to };
          })
        });
      }
    }
    provenance.accept({
      type: 'transaction',
      scope,
      changes: normalizedChanges(transaction),
      mutations
    });
  };

  const historyExtension = invertedEffects.of((transaction) => {
    const inverse: StateEffect<unknown>[] = [];
    const explicitlyRemappedIds = new Set<string>();
    for (const candidate of transaction.effects) {
      if (!candidate.is(provenanceEffect)) continue;
      const value = candidate.value;
      if (value.type === 'markInsertedRow') inverse.push(provenanceEffect.of({ ...value, type: 'removeInsertedRow' }));
      else if (value.type === 'removeInsertedRow') inverse.push(provenanceEffect.of({ ...value, type: 'markInsertedRow' }));
      else if (value.type === 'markDeletedRows') inverse.push(provenanceEffect.of({ ...value, type: 'removeDeletedRows' }));
      else if (value.type === 'removeDeletedRows') inverse.push(provenanceEffect.of({ ...value, type: 'markDeletedRows' }));
      else if (value.type === 'remapInsertedRows') {
        for (const row of value.rows) explicitlyRemappedIds.add(row.id);
        inverse.push(provenanceEffect.of({
          ...value,
          rows: value.rows.map(({ id, oldOffset, newOffset }) => ({
            id,
            oldOffset: newOffset,
            newOffset: oldOffset
          }))
        }));
      }
    }
    for (const row of replacedInsertedRows(provenance.snapshot(), transaction)) {
      if (!explicitlyRemappedIds.has(row.id)) {
        inverse.push(provenanceEffect.of({ ...row, type: 'markInsertedRow' }));
      }
    }
    return inverse;
  });

  const dispose = (): void => {
    provenance.accept({ type: 'dispose' });
  };

  const stateField = StateField.define<TableTransactionProvenance>({
    create: () => provenance,
    update(owner, transaction) {
      applyTransaction(transaction);
      return owner;
    }
  });

  const plugin = ViewPlugin.define(() => ({
    destroy() {
      dispose();
    }
  }));

  let extension: Extension = [];
  const adapter: CodeMirrorTableTransactionProvenanceAdapter = {
    get extension() { return extension; },
    effect,
    snapshot: () => provenance.snapshot(),
    dispose
  };
  extension = [
    tableTransactionProvenanceFacet.of(adapter),
    stateField,
    historyExtension,
    plugin
  ];
  return adapter;
}
