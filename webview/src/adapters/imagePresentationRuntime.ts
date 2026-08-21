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
 * Executes effects without retaining presentation identity. Application state
 * alone decides whether the latest work and its required projection have settled.
 */
export function createImagePresentationRuntime(
  options: ImagePresentationRuntimeOptions
): ImagePresentationRuntime {
  const { application, executor } = options;
  const idleWaiters = new Set<() => void>();
  let disposed = false;

  const isIdle = (): boolean => {
    const state = application.getState();
    if (state.lifecycle === 'disposed' || state.current === null) return true;
    if (state.current.phase !== 'ready' && state.current.phase !== 'error') return false;
    return state.projection === null;
  };

  const notifyIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const failureFor = (effect: ImagePresentationEffect): ImagePresentationInput => {
    switch (effect.type) {
      case 'resolveSource':
        return { type: 'sourceFailed', presentationId: effect.presentationId };
      case 'loadImage':
        return { type: 'imageFailed', presentationId: effect.presentationId };
      case 'showImage':
      case 'showFallback':
        return {
          type: 'projectionFailed',
          presentationId: effect.presentationId,
          commandId: effect.commandId
        };
    }
  };

  const dispatchInternal = (input: ImagePresentationInput): void => {
    if (disposed && input.type !== 'dispose') return;
    executeEffects(application.dispatch(input));
    notifyIdle();
  };

  function executeEffects(effects: readonly ImagePresentationEffect[]): void {
    for (const effect of effects) {
      let execution;
      try {
        execution = executor.execute(effect, {
          isCurrentProjection() {
            if (effect.type !== 'showImage' && effect.type !== 'showFallback') return false;
            const state = application.getState();
            return (
              state.lifecycle === 'active' &&
              state.current?.presentationId === effect.presentationId &&
              state.projection?.commandId === effect.commandId &&
              state.projection.target.presentationId === effect.presentationId
            );
          }
        });
      } catch {
        dispatchInternal(failureFor(effect));
        continue;
      }

      if ('immediateCompletion' in execution) {
        dispatchInternal(execution.immediateCompletion);
        continue;
      }
      void execution.completion.then(
        (input) => dispatchInternal(input),
        () => dispatchInternal(failureFor(effect))
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
      executor.dispose();
      notifyIdle();
    }
  };
}
