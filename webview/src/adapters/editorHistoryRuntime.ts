import type {
  EditorHistoryApplication,
  EditorHistoryEffect,
  EditorHistoryEffectExecutor,
  EditorHistoryInput,
  EditorHistoryRuntimeInput,
  EditorHistoryState
} from '../application/editorHistory';

export type EditorHistoryRuntime = {
  dispatch(input: EditorHistoryRuntimeInput): Promise<boolean | null>;
  flushPendingRestore(): void;
  whenIdle(): Promise<void>;
  whenSettled(): Promise<void>;
  getState(): EditorHistoryState;
  dispose(): void;
};

/** Serializes public inputs and native history while allowing focus retry to be cancelled. */
export function createEditorHistoryRuntime(
  application: EditorHistoryApplication,
  adapter: EditorHistoryEffectExecutor,
  reportUnexpectedError: (error: unknown) => void
): EditorHistoryRuntime {
  let operation = Promise.resolve();
  let disposed = false;
  let generation = 0;
  const deferredCompletions = new Set<Promise<void>>();

  const processEffect = async (
    effect: EditorHistoryEffect,
    currentGeneration: number
  ): Promise<boolean | null> => {
    const execution = adapter.execute(effect);
    if (!execution.completion) return null;

    if (execution.completionMode === 'deferred') {
      let trackedCompletion!: Promise<void>;
      trackedCompletion = execution.completion
        .then(async (completion) => {
          if (!completion || disposed || currentGeneration !== generation) return;
          await enqueueApplicationInput(completion, currentGeneration);
        })
        .catch(reportUnexpectedError)
        .finally(() => deferredCompletions.delete(trackedCompletion));
      deferredCompletions.add(trackedCompletion);
      return null;
    }

    const completion = await execution.completion;
    const replayApplied = completion?.type === 'nativeHistoryCompleted' ? completion.applied : null;
    if (completion && !disposed && currentGeneration === generation) {
      await processApplicationInput(completion, currentGeneration);
    }
    return replayApplied;
  };

  const processApplicationInput = async (
    input: EditorHistoryInput,
    currentGeneration: number
  ): Promise<boolean | null> => {
    if (disposed || currentGeneration !== generation) return null;
    const effects = application.dispatch(input);
    let replayApplied: boolean | null = null;
    for (const effect of effects) {
      if (disposed || currentGeneration !== generation) return replayApplied;
      const effectResult = await processEffect(effect, currentGeneration);
      if (effectResult !== null) replayApplied = effectResult;
    }
    return replayApplied;
  };

  const enqueueApplicationInput = (
    input: EditorHistoryInput,
    currentGeneration: number
  ): Promise<boolean | null> => {
    if (disposed || currentGeneration !== generation) return Promise.resolve(null);
    const result = operation.then(() => processApplicationInput(input, currentGeneration));
    operation = result.then(() => undefined).catch(reportUnexpectedError);
    return result;
  };

  const enqueue = (input: EditorHistoryRuntimeInput): Promise<boolean | null> => {
    if (disposed) return Promise.resolve(null);
    const currentGeneration = generation;
    // Preparation captures the user's viewport and invalidates any delayed
    // focus/scroll restore at the moment the input arrives. Deferring it behind
    // the operation queue lets an older replay keep moving the UI after a newer
    // key, pointer, or edit interaction has already happened.
    const preparedInput = adapter.prepareInput(input);
    const result = operation.then(() => processApplicationInput(preparedInput, currentGeneration));
    operation = result.then(() => undefined).catch(reportUnexpectedError);
    return result;
  };

  return {
    dispatch: enqueue,
    flushPendingRestore() {
      if (!disposed) adapter.flushPendingRestore();
    },
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
    async whenSettled() {
      while (true) {
        const currentOperation = operation;
        const currentDeferred = [...deferredCompletions];
        await currentOperation;
        await Promise.all(currentDeferred);
        await Promise.resolve();
        if (currentOperation === operation && deferredCompletions.size === 0) return;
      }
    },
    getState: () => application.getState(),
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const effects = application.dispatch({ type: 'dispose' });
      for (const effect of effects) {
        try {
          adapter.execute(effect);
        } catch (error) {
          reportUnexpectedError(error);
        }
      }
    }
  };
}
