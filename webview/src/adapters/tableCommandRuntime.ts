import type {
  TableCommandApplication,
  TableCommandEffect,
  TableCommandEffectExecutor,
  TableCommandInput,
  TableCommandState
} from '../application/tableCommand';

export type TableCommandRuntimeOutcome = 'changed' | 'presented' | 'no-op' | 'failed';

export type TableCommandRuntime = {
  dispatch(input: TableCommandInput): Promise<TableCommandRuntimeOutcome | null>;
  whenIdle(): Promise<void>;
  getState(): TableCommandState;
  dispose(): void;
};

/** Serializes table commands and rejects completions from an older runtime generation. */
export function createTableCommandRuntime(
  application: TableCommandApplication,
  executor: TableCommandEffectExecutor,
  reportUnexpectedError: (error: unknown) => void
): TableCommandRuntime {
  let operation = Promise.resolve();
  let disposed = false;
  let generation = 0;

  const processInput = async (
    input: TableCommandInput,
    currentGeneration: number
  ): Promise<TableCommandRuntimeOutcome | null> => {
    if (disposed || currentGeneration !== generation) return null;
    const before = application.getState();
    const acceptedCompletion = (
      (input.type === 'commandCompleted' || input.type === 'commandFailed') &&
      before.activeCommandId === input.commandId &&
      before.phase !== 'idle' &&
      before.phase !== 'disposed'
    );
    const effects = application.dispatch(input);
    let outcome: TableCommandRuntimeOutcome | null = acceptedCompletion
      ? input.type === 'commandCompleted' ? input.outcome : 'failed'
      : null;

    for (const effect of effects) {
      if (disposed || currentGeneration !== generation) return outcome;
      const effectOutcome = await processEffect(effect, currentGeneration);
      if (effectOutcome !== null) outcome = effectOutcome;
    }
    return outcome;
  };

  const failureFor = (effect: TableCommandEffect): TableCommandInput | null => {
    switch (effect.type) {
      case 'flushPendingEdits':
      case 'executeCommand':
        return { type: 'commandFailed', commandId: effect.commandId };
      case 'restoreInteraction':
        return null;
    }
  };

  const processEffect = async (
    effect: TableCommandEffect,
    currentGeneration: number
  ): Promise<TableCommandRuntimeOutcome | null> => {
    try {
      const completion = await executor.execute(effect).completion;
      if (!completion || disposed || currentGeneration !== generation) return null;
      return processInput(completion, currentGeneration);
    } catch (error) {
      reportUnexpectedError(error);
      if (disposed || currentGeneration !== generation) return null;
      const failure = failureFor(effect);
      return failure ? processInput(failure, currentGeneration) : null;
    }
  };

  const enqueue = (input: TableCommandInput): Promise<TableCommandRuntimeOutcome | null> => {
    if (disposed) return Promise.resolve(null);
    const currentGeneration = generation;
    const result = operation.then(() => processInput(input, currentGeneration));
    operation = result.then(() => undefined).catch(reportUnexpectedError);
    return result;
  };

  return {
    dispatch: enqueue,
    async whenIdle() {
      let current = operation;
      await current;
      await Promise.resolve();
      while (current !== operation) {
        current = operation;
        await current;
        await Promise.resolve();
      }
    },
    getState: application.getState,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      application.dispatch({ type: 'dispose' });
      try {
        executor.dispose();
      } catch (error) {
        reportUnexpectedError(error);
      }
    }
  };
}
