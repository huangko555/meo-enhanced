import type {
  DiagnosticSuggestionApplication,
  DiagnosticSuggestionEffect,
  DiagnosticSuggestionEffectExecutor,
  DiagnosticSuggestionInput
} from '../application/diagnosticSuggestion';

export type DiagnosticSuggestionRuntime = {
  dispatch(input: DiagnosticSuggestionInput): void;
  whenIdle(): Promise<void>;
  dispose(): void;
};

export type DiagnosticSuggestionRuntimeOptions = {
  readonly application: DiagnosticSuggestionApplication;
  readonly executor: DiagnosticSuggestionEffectExecutor;
};

/** Executes effects without serializing a new interaction behind an old request. */
export function createDiagnosticSuggestionRuntime(
  options: DiagnosticSuggestionRuntimeOptions
): DiagnosticSuggestionRuntime {
  const { application, executor } = options;
  const idleWaiters = new Set<() => void>();
  let disposed = false;

  const isIdle = (): boolean => disposed || application.isIdle();

  const notifyIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const failureFor = (effect: DiagnosticSuggestionEffect): DiagnosticSuggestionInput | null => (
    effect.type === 'requestSuggestions'
      ? { type: 'suggestionsFailed', correlationId: effect.correlationId }
      : null
  );

  const dispatchInternal = (input: DiagnosticSuggestionInput): void => {
    if (disposed && input.type !== 'dispose') return;
    executeEffects(application.dispatch(input));
    notifyIdle();
  };

  const complete = (input: DiagnosticSuggestionInput | null): void => {
    if (!disposed && input) dispatchInternal(input);
    notifyIdle();
  };

  function executeEffects(effects: readonly DiagnosticSuggestionEffect[]): void {
    for (const effect of effects) {
      let execution;
      try {
        execution = executor.execute(effect);
      } catch {
        const failure = failureFor(effect);
        if (failure) dispatchInternal(failure);
        continue;
      }

      if (effect.type !== 'requestSuggestions') continue;
      if (!execution.completion) {
        dispatchInternal({ type: 'suggestionsFailed', correlationId: effect.correlationId });
        continue;
      }

      void execution.completion.then(
        (input) => complete(input),
        () => complete(failureFor(effect))
      );
    }
  }

  return {
    dispatch: dispatchInternal,
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
    dispose() {
      if (disposed) return;
      dispatchInternal({ type: 'dispose' });
      disposed = true;
      executor.dispose();
      notifyIdle();
    }
  };
}
