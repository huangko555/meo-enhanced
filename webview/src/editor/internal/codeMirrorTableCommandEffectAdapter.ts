import type { TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type {
  TableCommand,
  TableCommandEffect,
  TableCommandEffectExecutor,
  TableCommandInput
} from '../../application/tableCommand';

type ExecuteCommandEffect = Extract<TableCommandEffect, { readonly type: 'executeCommand' }>;
type RestoreInteractionEffect = Extract<TableCommandEffect, { readonly type: 'restoreInteraction' }>;

export type TableCommandTransactionPlan = {
  readonly transaction: TransactionSpec | null;
  readonly outcome: 'changed' | 'no-op';
};

export type TableCommandEditorTarget = {
  readonly view: EditorView;
  buildPendingEditTransaction(): TransactionSpec | null;
  buildAtomicCommandTransaction(request: {
    readonly command: Exclude<TableCommand, 'preview-sort'>;
    readonly target: ExecuteCommandEffect['target'];
  }): TableCommandTransactionPlan;
  presentCommand(request: {
    readonly command: Extract<TableCommand, 'preview-sort'>;
    readonly target: ExecuteCommandEffect['target'];
  }): 'presented' | 'no-op';
  restoreInteraction(request: RestoreInteractionEffect): void;
};

export type CodeMirrorTableCommandEffectAdapterOptions = {
  resolveTarget(tableId: string): TableCommandEditorTarget | null;
  reportError(error: unknown): void;
  dispose(): void;
};

export type CodeMirrorTableCommandEffectAdapter = TableCommandEffectExecutor;

/**
 * Executes one Application effect against CodeMirror and the active table DOM.
 * Transaction builders remain Editor-internal; this adapter guarantees that
 * atomic commands dispatch their pending edits, command change and provenance
 * as one CodeMirror transaction.
 */
export function createCodeMirrorTableCommandEffectAdapter(
  options: CodeMirrorTableCommandEffectAdapterOptions
): CodeMirrorTableCommandEffectAdapter {
  let disposed = false;

  const complete = (
    effect: ExecuteCommandEffect
  ): TableCommandInput => {
    const target = options.resolveTarget(effect.target.tableId);
    if (!target) {
      return { type: 'commandCompleted', commandId: effect.commandId, outcome: 'no-op' };
    }

    if (effect.pendingEdits === 'flushed') {
      if (effect.command !== 'preview-sort') {
        throw new Error(`Only preview-sort may execute after a separate pending-edit flush`);
      }
      return {
        type: 'commandCompleted',
        commandId: effect.commandId,
        outcome: target.presentCommand({ command: effect.command, target: effect.target })
      };
    }

    if (effect.command === 'preview-sort') {
      throw new Error(`preview-sort must execute after pending edits are flushed`);
    }
    const plan = target.buildAtomicCommandTransaction({ command: effect.command, target: effect.target });
    if (plan.transaction) target.view.dispatch(plan.transaction);
    return { type: 'commandCompleted', commandId: effect.commandId, outcome: plan.outcome };
  };

  return {
    execute(effect) {
      if (disposed) return { completion: Promise.resolve(null) };

      switch (effect.type) {
        case 'flushPendingEdits':
          return {
            completion: Promise.resolve().then<TableCommandInput>(() => {
              if (disposed) return { type: 'commandFailed', commandId: effect.commandId };
              try {
                const target = options.resolveTarget(effect.tableId);
                const transaction = target?.buildPendingEditTransaction() ?? null;
                if (transaction) target?.view.dispatch(transaction);
                return { type: 'pendingEditsFlushed', commandId: effect.commandId };
              } catch (error) {
                options.reportError(error);
                return { type: 'commandFailed', commandId: effect.commandId };
              }
            })
          };

        case 'executeCommand':
          return {
            completion: Promise.resolve().then<TableCommandInput>(() => {
              if (disposed) return { type: 'commandFailed', commandId: effect.commandId };
              try {
                return complete(effect);
              } catch (error) {
                options.reportError(error);
                return { type: 'commandFailed', commandId: effect.commandId };
              }
            })
          };

        case 'restoreInteraction':
          return {
            completion: Promise.resolve().then(() => {
              if (disposed) return null;
              try {
                options.resolveTarget(effect.target.tableId)?.restoreInteraction(effect);
              } catch (error) {
                options.reportError(error);
              }
              return null;
            })
          };
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.dispose();
    }
  };
}
