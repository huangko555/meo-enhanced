import { Facet, type EditorState, type Extension, type StateEffect } from '@codemirror/state';
import type { TableTransactionProvenanceSnapshot } from '../application/tableTransactionProvenance';

/** Positions follow TransactionSpec: they refer to the document after the same spec's changes. */
export type CodeMirrorTableProvenanceIntent =
  | { readonly type: 'insertedRow'; readonly at: number; readonly assoc: -1 | 1; readonly offset?: number }
  | {
      readonly type: 'deletedRows';
      readonly at: number;
      readonly assoc: -1 | 1;
      readonly baselineRanges: ReadonlyArray<readonly [number, number]>;
      readonly deletionAtEnd: boolean;
    }
  | {
      readonly type: 'remapInsertedRows';
      readonly tableFrom: number;
      readonly rows: ReadonlyArray<{
        readonly id: string;
        readonly oldOffset: number;
        readonly newOffset: number;
      }>;
    }
  | { readonly type: 'baselineRefreshed' }
  | { readonly type: 'externalDocumentPresented' };

export type CodeMirrorTableTransactionProvenance = {
  readonly extension: Extension;
  effect(intent: CodeMirrorTableProvenanceIntent): StateEffect<unknown>;
  snapshot(): TableTransactionProvenanceSnapshot;
  dispose(): void;
};

export const tableTransactionProvenanceFacet = Facet.define<
  CodeMirrorTableTransactionProvenance,
  CodeMirrorTableTransactionProvenance | undefined
>({
  combine(values) {
    if (values.length > 1) throw new Error('Only one table transaction provenance Adapter may be installed');
    return values[0];
  }
});

export function getTableTransactionProvenance(
  state: EditorState
): CodeMirrorTableTransactionProvenance {
  const provenance = state.facet(tableTransactionProvenanceFacet);
  if (!provenance) throw new Error('CodeMirror table transaction provenance is not installed');
  return provenance;
}

export function getTableTransactionProvenanceSnapshot(
  state: EditorState
): TableTransactionProvenanceSnapshot {
  return getTableTransactionProvenance(state).snapshot();
}
