import type {
  EditorModeApplication,
  EditorModeEffect,
  EditorModeInput,
  EditorModeState
} from '../application/editorMode';
import type { EditorModeEffectAdapter } from './editorModeEffectAdapter';

export type EditorModeRuntime = {
  dispatch(input: EditorModeInput): Promise<void>;
  whenIdle(): Promise<void>;
  getState(): EditorModeState;
  dispose(): void;
};

/** Accepts intents immediately, serializes their effects, and correlates async completions. */
export function createEditorModeRuntime(
  application: EditorModeApplication,
  adapter: EditorModeEffectAdapter,
  reportUnexpectedError: (error: unknown) => void
): EditorModeRuntime {
  let operation = Promise.resolve();
  let disposed = false;
  let generation = 0;
  const completions = new Set<Promise<void>>();

  const enqueuePreparedInput = (input: EditorModeInput, currentGeneration: number): Promise<void> => {
    if (disposed || currentGeneration !== generation) return Promise.resolve();
    const effects = application.dispatch(adapter.prepareInput(input));
    const inputIntentId = application.getState().intentId;
    const result = operation.then(async () => {
      if (disposed || currentGeneration !== generation) return;
      if (application.getState().intentId !== inputIntentId) return;
      for (const effect of effects) {
        if (disposed || currentGeneration !== generation) return;
        if (application.getState().intentId !== inputIntentId) return;
        processEffect(effect, currentGeneration);
      }
    });
    operation = result.catch(reportUnexpectedError);
    return result;
  };

  const trackCompletion = (completion: Promise<EditorModeInput | null>, currentGeneration: number): void => {
    let tracked: Promise<void>;
    tracked = completion
      .then(async (input) => {
        if (input && !disposed && currentGeneration === generation) {
          await enqueuePreparedInput(input, currentGeneration);
        }
      })
      .catch(reportUnexpectedError)
      .finally(() => completions.delete(tracked));
    completions.add(tracked);
  };

  const processEffect = (effect: EditorModeEffect, currentGeneration: number): void => {
    const execution = adapter.execute(effect);
    if (execution.immediate && !disposed && currentGeneration === generation) {
      void enqueuePreparedInput(execution.immediate, currentGeneration);
    }
    if (execution.completion) trackCompletion(execution.completion, currentGeneration);
  };

  const whenIdle = async (): Promise<void> => {
    while (true) {
      const observedOperation = operation;
      await observedOperation;
      const observedCompletions = Array.from(completions);
      if (observedCompletions.length > 0) {
        await Promise.all(observedCompletions);
      }
      if (observedOperation === operation && completions.size === 0) return;
    }
  };

  const enqueue = (input: EditorModeInput): Promise<void> => {
    if (disposed) return Promise.resolve();
    const currentGeneration = generation;
    const result = enqueuePreparedInput(input, currentGeneration);
    return result.then(whenIdle);
  };

  return {
    dispatch: enqueue,
    whenIdle,
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
