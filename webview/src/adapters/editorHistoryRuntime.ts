import type {
  EditorHistoryApplication,
  EditorHistoryEffect,
  EditorHistoryInput,
  EditorHistoryState
} from '../application/editorHistory';
import type {
  EditorHistoryEffectAdapter,
  EditorHistoryRuntimeInput
} from './editorHistoryEffectAdapter';

export type EditorHistoryRuntime = {
  dispatch(input: EditorHistoryRuntimeInput): Promise<boolean | null>;
  whenIdle(): Promise<void>;
  getState(): EditorHistoryState;
  dispose(): void;
};

/** Serializes public inputs and native history while allowing focus retry to be cancelled. */
export function createEditorHistoryRuntime(
  application: EditorHistoryApplication,
  adapter: EditorHistoryEffectAdapter,
  reportUnexpectedError: (error: unknown) => void
): EditorHistoryRuntime {
  let operation = Promise.resolve();
  let disposed = false;
  let generation = 0;

  const processEffect = async (
    effect: EditorHistoryEffect,
    currentGeneration: number
  ): Promise<boolean | null> => {
    const execution = adapter.execute(effect);
    if (!execution.completion) return null;

    if (execution.completionMode === 'deferred') {
      void execution.completion
        .then((completion) => {
          if (!completion || disposed || currentGeneration !== generation) return;
          enqueueApplicationInput(completion, currentGeneration);
        })
        .catch(reportUnexpectedError);
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
    const result = operation.then(() => (
      processApplicationInput(adapter.prepareInput(input), currentGeneration)
    ));
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
