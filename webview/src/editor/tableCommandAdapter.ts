import { Facet, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type {
  TableCommand,
  TableCommandInput,
  TableCommandTarget
} from '../application/tableCommand';
import type { TableCellCommitConfirmation } from './tableCellInteraction';

export type TableCommandRuntimeRequest = {
  dispatch(input: Extract<TableCommandInput, { readonly type: 'request' }>): Promise<unknown>;
};

export type TableCommandTransactionPlan = {
  readonly transaction: TransactionSpec | null;
  readonly outcome: 'changed' | 'no-op';
  readonly preserveViewport?: boolean;
  readonly confirmations?: readonly TableCellCommitConfirmation[];
  readonly afterDispatch?: () => void;
  readonly restoreInteraction?: () => void;
};

export type TableCommandEditorTarget = {
  readonly view: EditorView;
  readonly identityKey: string;
  readonly from: number;
  isConnected(): boolean;
  buildAtomicCommandTransaction(request: {
    readonly command: TableCommand;
    readonly target: TableCommandTarget;
  }): TableCommandTransactionPlan;
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
