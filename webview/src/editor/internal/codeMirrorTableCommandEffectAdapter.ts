import type {
  TableCommandEffect,
  TableCommandEffectExecutor,
  TableCommandInput
} from '../../application/tableCommand';
import type {
  TableCommandEditorTarget,
  TableCommandTransactionPlan
} from '../tableCommandAdapter';

type ExecuteCommandEffect = Extract<TableCommandEffect, { readonly type: 'executeCommand' }>;
type RestoreInteractionEffect = Extract<TableCommandEffect, { readonly type: 'restoreInteraction' }>;

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
  const pendingRestores = new Map<number, () => void>();
  const immediate = (completion: TableCommandInput | null) => ({
    immediateCompletion: completion,
    completion: Promise.resolve(completion)
  });

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
    if (plan.restoreInteraction) pendingRestores.set(effect.commandId, plan.restoreInteraction);
    if (plan.transaction) {
      const dispatch = () => target.view.dispatch(plan.transaction!);
      if (plan.preserveViewport) target.preserveViewport(dispatch);
      else dispatch();
      plan.afterDispatch?.();
    }
    return { type: 'commandCompleted', commandId: effect.commandId, outcome: plan.outcome };
  };

  return {
    execute(effect) {
      if (disposed) return immediate(null);

      switch (effect.type) {
        case 'flushPendingEdits':
          try {
            const target = options.resolveTarget(effect.tableId);
            const transactions = target?.buildPendingEditTransactions() ?? [];
            if (transactions.length) target?.view.dispatch(transactions);
            return immediate({ type: 'pendingEditsFlushed', commandId: effect.commandId });
          } catch (error) {
            options.reportError(error);
            return immediate({ type: 'commandFailed', commandId: effect.commandId });
          }

        case 'executeCommand':
          try {
            return immediate(complete(effect));
          } catch (error) {
            options.reportError(error);
            return immediate({ type: 'commandFailed', commandId: effect.commandId });
          }

        case 'restoreInteraction':
          try {
            const restore = pendingRestores.get(effect.commandId);
            pendingRestores.delete(effect.commandId);
            restore?.();
          } catch (error) {
            options.reportError(error);
          }
          return immediate(null);
      }
    },
    invalidate() {
      if (disposed) return;
      pendingRestores.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingRestores.clear();
      options.dispose();
    }
  };
}
