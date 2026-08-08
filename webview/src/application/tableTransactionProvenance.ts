export type TableInsertedRowHint = {
  readonly id: string;
  readonly from: number;
  readonly to: number;
};

export type TableDeletedRowsHint = {
  readonly id: string;
  readonly at: number;
  readonly baselineRanges: ReadonlyArray<readonly [number, number]>;
  readonly deletionAtEnd: boolean;
};

export type TableProvenanceMutation =
  /** Mutation positions are measured in the document after `changes`. */
  | ({ readonly type: 'markInsertedRow' } & TableInsertedRowHint)
  | { readonly type: 'removeInsertedRow'; readonly id: string }
  | { readonly type: 'remapInsertedRows'; readonly rows: ReadonlyArray<TableInsertedRowHint> }
  | ({ readonly type: 'markDeletedRows' } & TableDeletedRowsHint)
  | { readonly type: 'removeDeletedRows'; readonly id: string };

export type TableProvenanceTextChange = {
  /** Half-open coordinates in the document before this transaction. */
  readonly from: number;
  readonly to: number;
  readonly insertedLength: number;
};

export type TableTransactionProvenanceInput =
  | {
      readonly type: 'transaction';
      /** Use the latest snapshot scope; stale mutations are ignored while their text mapping still applies. */
      readonly scope: number;
      readonly changes: ReadonlyArray<TableProvenanceTextChange>;
      readonly mutations: ReadonlyArray<TableProvenanceMutation>;
    }
  | { readonly type: 'baselineRefreshed' }
  | { readonly type: 'externalDocumentPresented' }
  | { readonly type: 'dispose' };

export type TableTransactionProvenanceSnapshot = {
  readonly lifecycle: 'active' | 'disposed';
  /** Correlates history inversions with the baseline/document presentation that created them. */
  readonly scope: number;
  readonly insertedRows: ReadonlyArray<TableInsertedRowHint>;
  readonly deletedRows: ReadonlyArray<TableDeletedRowsHint>;
};

export type TableTransactionProvenance = {
  snapshot(): TableTransactionProvenanceSnapshot;
  accept(input: TableTransactionProvenanceInput): TableTransactionProvenanceSnapshot;
};

function mapPosition(
  position: number,
  assoc: -1 | 1,
  changes: ReadonlyArray<TableProvenanceTextChange>
): number {
  let offset = 0;
  for (const change of changes) {
    if (position < change.from || (position === change.from && assoc < 0)) break;
    if (position > change.to || (position === change.to && assoc > 0)) {
      offset += change.insertedLength - (change.to - change.from);
      continue;
    }
    return change.from + offset + (assoc > 0 ? change.insertedLength : 0);
  }
  return position + offset;
}

function fullyReplacesRow(change: TableProvenanceTextChange, row: TableInsertedRowHint): boolean {
  return change.to > change.from && change.from <= row.from && change.to >= row.to;
}

/**
 * Owns only row-origin hints used to disambiguate a diff. Document text,
 * native history, Revision/Draft/Change and the diff baseline remain external owners.
 */
export function createTableTransactionProvenance(): TableTransactionProvenance {
  let lifecycle: TableTransactionProvenanceSnapshot['lifecycle'] = 'active';
  let scope = 0;
  let insertedRows: TableInsertedRowHint[] = [];
  let deletedRows: TableDeletedRowsHint[] = [];

  const snapshot = (): TableTransactionProvenanceSnapshot => ({
    lifecycle,
    scope,
    insertedRows: insertedRows
      .map((row) => ({ ...row }))
      .sort((left, right) => left.from - right.from || left.to - right.to || left.id.localeCompare(right.id)),
    deletedRows: deletedRows
      .map((row) => ({
        ...row,
        baselineRanges: row.baselineRanges.map(([from, to]) => [from, to] as const)
      }))
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
  });

  const reset = (): TableTransactionProvenanceSnapshot => {
    scope += 1;
    insertedRows = [];
    deletedRows = [];
    return snapshot();
  };

  const accept = (input: TableTransactionProvenanceInput): TableTransactionProvenanceSnapshot => {
    if (lifecycle === 'disposed') return snapshot();
    if (input.type === 'dispose') {
      lifecycle = 'disposed';
      return reset();
    }
    if (input.type === 'baselineRefreshed' || input.type === 'externalDocumentPresented') return reset();

    const changes = [...input.changes].sort((left, right) => left.from - right.from || left.to - right.to);
    insertedRows = insertedRows
      .filter((row) => !changes.some((change) => fullyReplacesRow(change, row)))
      .map((row) => ({
        ...row,
        from: mapPosition(row.from, 1, changes),
        to: mapPosition(row.to, -1, changes)
      }))
      .filter(({ from, to }) => from < to);
    deletedRows = deletedRows.map((row) => ({
      ...row,
      at: mapPosition(row.at, row.deletionAtEnd ? -1 : 1, changes)
    }));

    if (input.scope !== scope) return snapshot();
    for (const mutation of input.mutations) {
      switch (mutation.type) {
        case 'markInsertedRow':
          insertedRows = [
            ...insertedRows.filter(({ id }) => id !== mutation.id),
            { id: mutation.id, from: mutation.from, to: mutation.to }
          ];
          break;
        case 'removeInsertedRow':
          insertedRows = insertedRows.filter(({ id }) => id !== mutation.id);
          break;
        case 'remapInsertedRows': {
          const remappedIds = new Set(mutation.rows.map(({ id }) => id));
          insertedRows = [
            ...insertedRows.filter(({ id }) => !remappedIds.has(id)),
            ...mutation.rows.map(({ id, from, to }) => ({ id, from, to }))
          ];
          break;
        }
        case 'markDeletedRows':
          deletedRows = [
            ...deletedRows.filter(({ id }) => id !== mutation.id),
            {
              id: mutation.id,
              at: mutation.at,
              baselineRanges: mutation.baselineRanges.map(([from, to]) => [from, to]),
              deletionAtEnd: mutation.deletionAtEnd
            }
          ];
          break;
        case 'removeDeletedRows':
          deletedRows = deletedRows.filter(({ id }) => id !== mutation.id);
          break;
      }
    }
    return snapshot();
  };

  return { snapshot, accept };
}
