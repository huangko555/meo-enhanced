import { Facet, type Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type {
  TableCommand,
  TableCommandInput,
  TableCommandTarget
} from '../application/tableCommand';

export type TableCommandRuntimeRequest = {
  dispatch(input: Extract<TableCommandInput, { readonly type: 'request' }>): Promise<unknown>;
};

export type TableCommandTransactionPlan = {
  readonly transaction: TransactionSpec | null;
  readonly outcome: 'changed' | 'no-op';
  readonly preserveViewport?: boolean;
  readonly afterDispatch?: () => void;
  readonly restoreInteraction?: () => void;
};

export type TableCommandEditorTarget = {
  readonly view: EditorView;
  readonly identityKey: string;
  readonly from: number;
  isConnected(): boolean;
  buildPendingEditTransactions(): readonly Transaction[];
  buildAtomicCommandTransaction(request: {
    readonly command: Exclude<TableCommand, 'preview-sort'>;
    readonly target: TableCommandTarget;
  }): TableCommandTransactionPlan;
  presentCommand(request: {
    readonly command: Extract<TableCommand, 'preview-sort'>;
    readonly target: TableCommandTarget;
  }): 'presented' | 'no-op';
  preserveViewport(run: () => void): void;
};

export type TableCommandTargetRegistration = { readonly id: string; dispose(): void };

export type TableCommandEnvironment = TableCommandRuntimeRequest & {
  registerTarget(target: TableCommandEditorTarget): TableCommandTargetRegistration;
};

export const tableCommandEnvironmentFacet = Facet.define<TableCommandEnvironment | null, TableCommandEnvironment | null>({
  combine(values) {
    return values.length ? values[values.length - 1] : null;
  }
});
