export type TableCommand =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'delete-column'
  | 'align-left'
  | 'align-center'
  | 'align-right';

export type TableCommandSelection = {
  readonly fromRow: number;
  readonly toRow: number;
  readonly fromColumn: number;
  readonly toColumn: number;
};

export type TableCommandTarget = {
  readonly tableId: string;
  readonly row: number | null;
  readonly column: number | null;
  readonly selection: TableCommandSelection | null;
};

export type TableCommandState = {
  readonly phase: 'idle' | 'executing' | 'disposed';
  readonly activeCommandId: number | null;
};

export type TableCommandInput =
  | {
      readonly type: 'request';
      readonly command: TableCommand;
      readonly target: TableCommandTarget;
      readonly enabled: boolean;
    }
  | {
      readonly type: 'commandCompleted';
      readonly commandId: number;
      readonly outcome: 'changed' | 'no-op';
    }
  | { readonly type: 'commandFailed'; readonly commandId: number }
  | { readonly type: 'externalDocumentPresented' }
  | { readonly type: 'dispose' };

export type TableCommandEffect =
  | {
      readonly type: 'executeCommand';
      readonly commandId: number;
      readonly command: TableCommand;
      readonly target: TableCommandTarget;
      readonly pendingEdits: 'atomic';
    }
  | {
      readonly type: 'restoreInteraction';
      readonly commandId: number;
      readonly target: TableCommandTarget;
      readonly outcome: 'changed' | 'failed';
    };

export type TableCommandApplication = {
  getState(): TableCommandState;
  dispatch(input: TableCommandInput): readonly TableCommandEffect[];
};

export type TableCommandEffectExecution = {
  readonly immediateCompletion?: TableCommandInput | null;
  readonly completion?: Promise<TableCommandInput | null>;
};

/** Application-owned port implemented by deterministic and Editor adapters. */
export type TableCommandEffectExecutor = {
  execute(effect: TableCommandEffect): TableCommandEffectExecution;
  externalDocumentPresented(): void;
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
    outcome: 'changed' | 'no-op' | 'failed'
  ): readonly TableCommandEffect[] => {
    if (
      !active ||
      active.id !== commandId ||
      phase !== 'executing'
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
        phase = 'executing';
        return [{
          type: 'executeCommand',
          commandId: id,
          command: input.command,
          target: input.target,
          pendingEdits: 'atomic'
        }];
      }
      case 'commandCompleted':
        return finish(input.commandId, input.outcome);
      case 'commandFailed':
        return finish(input.commandId, 'failed');
      case 'externalDocumentPresented':
        active = null;
        phase = 'idle';
        return [];
      case 'dispose':
        active = null;
        phase = 'disposed';
        return [];
    }
  };

  return { getState, dispatch };
}
