import type {
  TableCommandApplication,
  TableCommandEffect,
  TableCommandEffectExecutor,
  TableCommandInput,
  TableCommandState
} from '../application/tableCommand';

export type TableCommandRuntimeOutcome = 'changed' | 'no-op' | 'failed';

export type TableCommandRuntime = {
  dispatch(input: TableCommandInput): Promise<TableCommandRuntimeOutcome | null>;
  whenIdle(): Promise<void>;
  getState(): TableCommandState;
  externalDocumentPresented(): void;
  dispose(): void;
};

/** Serializes table commands and rejects completions from an older runtime generation. */
export function createTableCommandRuntime(
  application: TableCommandApplication,
  executor: TableCommandEffectExecutor,
  reportUnexpectedError: (error: unknown) => void
): TableCommandRuntime {
  type QueueState = { operation: Promise<unknown>; pendingOperations: number };
  let queue: QueueState = { operation: Promise.resolve(), pendingOperations: 0 };
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
      const execution = executor.execute(effect);
      const completion = Object.prototype.hasOwnProperty.call(execution, 'immediateCompletion')
        ? execution.immediateCompletion ?? null
        : await execution.completion;
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
    const currentQueue = queue;
    const result = currentQueue.pendingOperations === 0
      ? processInput(input, currentGeneration)
      : currentQueue.operation.then(() => processInput(input, currentGeneration));
    currentQueue.pendingOperations += 1;
    currentQueue.operation = result.then(
      () => {
        currentQueue.pendingOperations -= 1;
      },
      (error) => {
        currentQueue.pendingOperations -= 1;
        reportUnexpectedError(error);
      }
    );
    return result;
  };

  return {
    dispatch: enqueue,
    async whenIdle() {
      const currentQueue = queue;
      let current = currentQueue.operation;
      await current;
      await Promise.resolve();
      while (currentQueue === queue && current !== currentQueue.operation) {
        current = currentQueue.operation;
        await current;
        await Promise.resolve();
      }
    },
    getState: application.getState,
    externalDocumentPresented() {
      if (disposed) return;
      generation += 1;
      queue = { operation: Promise.resolve(), pendingOperations: 0 };
      application.dispatch({ type: 'externalDocumentPresented' });
      try {
        executor.externalDocumentPresented();
      } catch (error) {
        reportUnexpectedError(error);
      }
    },
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
