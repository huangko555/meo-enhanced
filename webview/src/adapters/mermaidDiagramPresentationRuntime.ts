import type {
  MermaidDiagramPresentationApplication,
  MermaidDiagramPresentationEffect,
  MermaidDiagramPresentationEffectExecutor,
  MermaidDiagramPresentationInput
} from '../application/mermaidDiagramPresentation';

export type MermaidDiagramPresentationRuntime = {
  dispatch(input: MermaidDiagramPresentationInput): void;
  whenCurrentPresentationSettles(): Promise<void>;
  dispose(): void;
};

export type MermaidDiagramPresentationRuntimeOptions = {
  readonly application: MermaidDiagramPresentationApplication;
  readonly executor: MermaidDiagramPresentationEffectExecutor;
};

/** Executes presentation effects without serializing a newer source behind an older render. */
export function createMermaidDiagramPresentationRuntime(
  options: MermaidDiagramPresentationRuntimeOptions
): MermaidDiagramPresentationRuntime {
  const { application, executor } = options;
  const pendingByPresentation = new Map<number, number>();
  const idleWaiters = new Set<() => void>();
  let disposed = false;

  const isIdle = (): boolean => {
    const state = application.getState();
    if (state.phase === 'disposed' || state.phase === 'idle') return true;
    if (state.phase !== 'ready' && state.phase !== 'error') return false;
    return state.presentationId === null || (pendingByPresentation.get(state.presentationId) ?? 0) === 0;
  };

  const notifyIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const failureFor = (
    effect: MermaidDiagramPresentationEffect,
    reason: unknown
  ): MermaidDiagramPresentationInput | null => effect.type === 'renderDiagram'
    ? {
        type: 'renderFailed',
        presentationId: effect.presentationId,
        error: reason instanceof Error ? reason.message : String(reason)
      }
    : null;

  const dispatchInternal = (input: MermaidDiagramPresentationInput): void => {
    if (disposed && input.type !== 'dispose') return;
    executeEffects(application.dispatch(input));
    notifyIdle();
  };

  const complete = (
    presentationId: number,
    input: MermaidDiagramPresentationInput | null
  ): void => {
    const remaining = (pendingByPresentation.get(presentationId) ?? 1) - 1;
    if (remaining > 0) pendingByPresentation.set(presentationId, remaining);
    else pendingByPresentation.delete(presentationId);
    if (!disposed) {
      dispatchInternal(input ?? { type: 'renderUnavailable', presentationId });
    }
    notifyIdle();
  };

  function executeEffects(effects: readonly MermaidDiagramPresentationEffect[]): void {
    for (const effect of effects) {
      let execution;
      try {
        execution = executor.execute(effect);
      } catch (error) {
        const failure = failureFor(effect, error);
        if (failure) dispatchInternal(failure);
        continue;
      }
      if (execution.immediate) {
        dispatchInternal(execution.immediate);
        continue;
      }
      if (!execution.completion) continue;
      pendingByPresentation.set(
        effect.presentationId,
        (pendingByPresentation.get(effect.presentationId) ?? 0) + 1
      );
      void execution.completion.then(
        (input) => complete(effect.presentationId, input),
        (error) => complete(effect.presentationId, failureFor(effect, error))
      );
    }
  }

  return {
    dispatch: dispatchInternal,
    whenCurrentPresentationSettles() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
    dispose() {
      if (disposed) return;
      dispatchInternal({ type: 'dispose' });
      disposed = true;
      pendingByPresentation.clear();
      executor.dispose();
      notifyIdle();
    }
  };
}
