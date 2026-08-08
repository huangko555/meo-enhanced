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

/** Serializes Application inputs, effect execution, completions, and teardown. */
export function createEditorModeRuntime(
  application: EditorModeApplication,
  adapter: EditorModeEffectAdapter,
  reportUnexpectedError: (error: unknown) => void
): EditorModeRuntime {
  let operation = Promise.resolve();
  let disposed = false;
  let generation = 0;

  const processEffect = async (effect: EditorModeEffect, currentGeneration: number): Promise<void> => {
    const execution = adapter.execute(effect);
    if (execution.immediate && !disposed && currentGeneration === generation) {
      await processInput(execution.immediate, currentGeneration);
    }
    if (!execution.completion) return;
    const completion = await execution.completion;
    if (completion && !disposed && currentGeneration === generation) {
      await processInput(completion, currentGeneration);
    }
  };

  const processInput = async (input: EditorModeInput, currentGeneration: number): Promise<void> => {
    if (disposed || currentGeneration !== generation) return;
    const effects = application.dispatch(adapter.prepareInput(input));
    for (const effect of effects) {
      if (disposed || currentGeneration !== generation) return;
      await processEffect(effect, currentGeneration);
    }
  };

  const enqueue = (input: EditorModeInput): Promise<void> => {
    if (disposed) return Promise.resolve();
    const currentGeneration = generation;
    const result = operation.then(() => processInput(input, currentGeneration));
    operation = result.catch(reportUnexpectedError);
    return result;
  };

  return {
    dispatch: enqueue,
    whenIdle: () => operation,
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
