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
  const pendingByCorrelation = new Map<number, number>();
  const idleWaiters = new Set<() => void>();
  let disposed = false;

  const isIdle = (): boolean => disposed || application.getState().pending === null;

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

  const complete = (correlationId: number, input: DiagnosticSuggestionInput | null): void => {
    const remaining = (pendingByCorrelation.get(correlationId) ?? 1) - 1;
    if (remaining > 0) pendingByCorrelation.set(correlationId, remaining);
    else pendingByCorrelation.delete(correlationId);
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

      pendingByCorrelation.set(
        effect.correlationId,
        (pendingByCorrelation.get(effect.correlationId) ?? 0) + 1
      );
      void execution.completion.then(
        (input) => complete(effect.correlationId, input),
        () => complete(effect.correlationId, failureFor(effect))
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
      pendingByCorrelation.clear();
      executor.dispose();
      notifyIdle();
    }
  };
}
