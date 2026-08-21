import type {
  ImagePresentationApplication,
  ImagePresentationEffect,
  ImagePresentationEffectExecutor,
  ImagePresentationInput
} from '../application/imagePresentation';

export type ImagePresentationRuntime = {
  dispatch(input: ImagePresentationInput): void;
  whenCurrentPresentationSettles(): Promise<void>;
  dispose(): void;
};

export type ImagePresentationRuntimeOptions = {
  readonly application: ImagePresentationApplication;
  readonly executor: ImagePresentationEffectExecutor;
};

/**
 * Executes effects without serializing unrelated resource promises. The
 * Application remains the sole owner of presentation correlation and phase.
 */
export function createImagePresentationRuntime(
  options: ImagePresentationRuntimeOptions
): ImagePresentationRuntime {
  const { application, executor } = options;
  const pendingByPresentation = new Map<number, number>();
  const idleWaiters = new Set<() => void>();
  let disposed = false;

  const isIdle = (): boolean => {
    const state = application.getState();
    if (state.lifecycle === 'disposed' || state.current === null) return true;
    if (state.current.phase !== 'ready' && state.current.phase !== 'error') return false;
    return (pendingByPresentation.get(state.current.presentationId) ?? 0) === 0;
  };

  const notifyIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const dispatchInternal = (input: ImagePresentationInput): void => {
    if (disposed && input.type !== 'dispose') return;
    executeEffects(application.dispatch(input));
    notifyIdle();
  };

  const failureFor = (effect: ImagePresentationEffect): ImagePresentationInput | null => {
    if (effect.type === 'resolveSource') {
      return { type: 'sourceFailed', presentationId: effect.presentationId };
    }
    if (effect.type === 'loadImage') {
      return { type: 'imageFailed', presentationId: effect.presentationId };
    }
    return null;
  };

  const complete = (presentationId: number, input: ImagePresentationInput | null): void => {
    const remaining = (pendingByPresentation.get(presentationId) ?? 1) - 1;
    if (remaining > 0) pendingByPresentation.set(presentationId, remaining);
    else pendingByPresentation.delete(presentationId);
    if (!disposed && input) dispatchInternal(input);
    notifyIdle();
  };

  function executeEffects(effects: readonly ImagePresentationEffect[]): void {
    for (const effect of effects) {
      let execution;
      try {
        execution = executor.execute(effect);
      } catch {
        const failure = failureFor(effect);
        if (failure) dispatchInternal(failure);
        continue;
      }

      if (execution.immediateCompletion) {
        dispatchInternal(execution.immediateCompletion);
      }
      if (!execution.completion) continue;

      pendingByPresentation.set(
        effect.presentationId,
        (pendingByPresentation.get(effect.presentationId) ?? 0) + 1
      );
      void execution.completion.then(
        (input) => complete(effect.presentationId, input),
        () => complete(effect.presentationId, failureFor(effect))
      );
    }
  }

  return {
    dispatch(input) {
      dispatchInternal(input);
    },
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
