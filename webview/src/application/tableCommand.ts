export type TableCommand =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'delete-column'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'preview-sort'
  | 'apply-sort';

export type TableCommandTarget = {
  readonly tableId: string;
  readonly row: number | null;
  readonly column: number | null;
};

export type TableCommandState = {
  readonly phase: 'idle' | 'flushing-pending-edits' | 'executing' | 'disposed';
  readonly activeCommandId: number | null;
};

export type TableCommandInput =
  | {
      readonly type: 'request';
      readonly command: TableCommand;
      readonly target: TableCommandTarget;
      readonly enabled: boolean;
    }
  | { readonly type: 'pendingEditsFlushed'; readonly commandId: number }
  | {
      readonly type: 'commandCompleted';
      readonly commandId: number;
      readonly outcome: 'changed' | 'presented' | 'no-op';
    }
  | { readonly type: 'commandFailed'; readonly commandId: number }
  | { readonly type: 'dispose' };

export type TableCommandEffect =
  | { readonly type: 'flushPendingEdits'; readonly commandId: number; readonly tableId: string }
  | {
      readonly type: 'executeCommand';
      readonly commandId: number;
      readonly command: TableCommand;
      readonly target: TableCommandTarget;
      readonly pendingEdits: 'atomic' | 'flushed';
    }
  | {
      readonly type: 'restoreInteraction';
      readonly commandId: number;
      readonly target: TableCommandTarget;
      readonly outcome: 'changed' | 'presented' | 'failed';
    };

export type TableCommandApplication = {
  getState(): TableCommandState;
  dispatch(input: TableCommandInput): readonly TableCommandEffect[];
};

export type TableCommandEffectExecution = {
  readonly completion?: Promise<TableCommandInput | null>;
};

/** Application-owned port implemented by deterministic and Editor adapters. */
export type TableCommandEffectExecutor = {
  execute(effect: TableCommandEffect): TableCommandEffectExecution;
  dispose(): void;
};

type ActiveCommand = {
  readonly id: number;
  readonly command: TableCommand;
  readonly target: TableCommandTarget;
};

/**
 * Owns one table command's sequencing and completion identity.
 * Concrete adapters keep Markdown parsing, CodeMirror transactions, provenance,
 * focus and viewport capabilities outside this state machine.
 */
export function createTableCommandApplication(): TableCommandApplication {
  let phase: TableCommandState['phase'] = 'idle';
  let sequence = 0;
  let active: ActiveCommand | null = null;

  const getState = (): TableCommandState => ({
    phase,
    activeCommandId: active?.id ?? null
  });

  const finish = (
    commandId: number,
    outcome: 'changed' | 'presented' | 'no-op' | 'failed'
  ): readonly TableCommandEffect[] => {
    if (
      !active ||
      active.id !== commandId ||
      (phase !== 'executing' && !(outcome === 'failed' && phase === 'flushing-pending-edits'))
    ) return [];
    const completed = active;
    active = null;
    phase = 'idle';
    if (outcome === 'no-op') return [];
    return [{
      type: 'restoreInteraction',
      commandId,
      target: completed.target,
      outcome
    }];
  };

  const dispatch = (input: TableCommandInput): readonly TableCommandEffect[] => {
    if (phase === 'disposed') return [];

    switch (input.type) {
      case 'request': {
        if (!input.enabled || phase !== 'idle') return [];
        const id = ++sequence;
        active = { id, command: input.command, target: input.target };
        if (input.command === 'preview-sort') {
          phase = 'flushing-pending-edits';
          return [{ type: 'flushPendingEdits', commandId: id, tableId: input.target.tableId }];
        }
        phase = 'executing';
        return [{
          type: 'executeCommand',
          commandId: id,
          command: input.command,
          target: input.target,
          pendingEdits: 'atomic'
        }];
      }
      case 'pendingEditsFlushed': {
        if (!active || active.id !== input.commandId || phase !== 'flushing-pending-edits') return [];
        phase = 'executing';
        return [{
          type: 'executeCommand',
          commandId: active.id,
          command: active.command,
          target: active.target,
          pendingEdits: 'flushed'
        }];
      }
      case 'commandCompleted':
        return finish(input.commandId, input.outcome);
      case 'commandFailed':
        return finish(input.commandId, 'failed');
      case 'dispose':
        active = null;
        phase = 'disposed';
        return [];
    }
  };

  return { getState, dispatch };
}
