export type ImagePresentationWorkPhase =
  | 'resolving'
  | 'loading'
  | 'ready'
  | 'error';

export type ImagePresentationCurrent = {
  readonly phase: ImagePresentationWorkPhase;
  readonly presentationId: number;
  readonly sourceKey: string;
  readonly rawSrc: string;
  readonly resolvedSrc: string | null;
};

export type ImageProjectedPresentation =
  | { readonly phase: 'none' }
  | {
      readonly phase: 'fallback' | 'error';
      readonly presentationId: number;
      readonly sourceKey: string;
    }
  | {
      readonly phase: 'ready';
      readonly presentationId: number;
      readonly sourceKey: string;
      readonly resolvedSrc: string;
    };

export type ImagePresentationState = {
  readonly lifecycle: 'active' | 'disposed';
  readonly current: ImagePresentationCurrent | null;
  readonly projected: ImageProjectedPresentation;
};

export type ImagePresentationInput =
  | { readonly type: 'present'; readonly sourceKey: string; readonly rawSrc: string }
  | { readonly type: 'sourceResolved'; readonly presentationId: number; readonly resolvedSrc: string }
  | { readonly type: 'sourceFailed'; readonly presentationId: number }
  | { readonly type: 'imageLoaded'; readonly presentationId: number }
  | { readonly type: 'imageFailed'; readonly presentationId: number }
  | { readonly type: 'externalDocumentPresented' }
  | { readonly type: 'dispose' };

export type ImagePresentationEffect =
  | {
      readonly type: 'resolveSource';
      readonly presentationId: number;
      readonly rawSrc: string;
    }
  | {
      readonly type: 'loadImage';
      readonly presentationId: number;
      readonly resolvedSrc: string;
    }
  | {
      readonly type: 'showImage';
      readonly presentationId: number;
      readonly resolvedSrc: string;
    }
  | {
      readonly type: 'showFallback';
      readonly presentationId: number;
      readonly sourceKey: string;
    };

export type ImagePresentationApplication = {
  getState(): ImagePresentationState;
  dispatch(input: ImagePresentationInput): readonly ImagePresentationEffect[];
};

export type ImagePresentationEffectExecution = {
  readonly immediateCompletion?: ImagePresentationInput | null;
  readonly completion?: Promise<ImagePresentationInput | null>;
};

/** Application-owned port implemented by deterministic and Editor adapters. */
export type ImagePresentationEffectExecutor = {
  execute(effect: ImagePresentationEffect): ImagePresentationEffectExecution;
  dispose(): void;
};

/**
 * Owns both the latest asynchronous work and the presentation currently
 * projected into the DOM. Keeping those identities separate lets a ready
 * projection remain stable while a newer generation resolves and loads.
 */
export function createImagePresentationApplication(): ImagePresentationApplication {
  let lifecycle: ImagePresentationState['lifecycle'] = 'active';
  let sequence = 0;
  let current: ImagePresentationCurrent | null = null;
  let projected: ImageProjectedPresentation = { phase: 'none' };

  const getState = (): ImagePresentationState => ({ lifecycle, current, projected });

  const currentInPhase = (
    candidateId: number,
    expectedPhase: ImagePresentationWorkPhase
  ): ImagePresentationCurrent | null => (
    current?.presentationId === candidateId && current.phase === expectedPhase
      ? current
      : null
  );

  const beginPresentation = (
    sourceKey: string,
    rawSrc: string
  ): readonly ImagePresentationEffect[] => {
    const presentationId = ++sequence;
    current = {
      phase: 'resolving',
      presentationId,
      sourceKey,
      rawSrc,
      resolvedSrc: null
    };

    const effects: ImagePresentationEffect[] = [];
    if (projected.phase !== 'ready') {
      projected = { phase: 'fallback', presentationId, sourceKey };
      effects.push({ type: 'showFallback', presentationId, sourceKey });
    }
    effects.push({ type: 'resolveSource', presentationId, rawSrc });
    return effects;
  };

  const failCurrent = (presentationId: number): readonly ImagePresentationEffect[] => {
    if (!current) return [];
    current = { ...current, phase: 'error', resolvedSrc: null };
    projected = {
      phase: 'error',
      presentationId,
      sourceKey: current.sourceKey
    };
    return [{
      type: 'showFallback',
      presentationId,
      sourceKey: current.sourceKey
    }];
  };

  const dispatch = (input: ImagePresentationInput): readonly ImagePresentationEffect[] => {
    if (lifecycle === 'disposed') return [];

    switch (input.type) {
      case 'present':
        return beginPresentation(input.sourceKey, input.rawSrc);
      case 'sourceResolved': {
        const active = currentInPhase(input.presentationId, 'resolving');
        if (!active || !input.resolvedSrc) return [];
        current = { ...active, phase: 'loading', resolvedSrc: input.resolvedSrc };
        return [{
          type: 'loadImage',
          presentationId: input.presentationId,
          resolvedSrc: input.resolvedSrc
        }];
      }
      case 'sourceFailed':
        if (!currentInPhase(input.presentationId, 'resolving')) return [];
        return failCurrent(input.presentationId);
      case 'imageLoaded': {
        const active = currentInPhase(input.presentationId, 'loading');
        if (!active || active.resolvedSrc === null) return [];
        current = { ...active, phase: 'ready' };
        projected = {
          phase: 'ready',
          presentationId: input.presentationId,
          sourceKey: active.sourceKey,
          resolvedSrc: active.resolvedSrc
        };
        return [{
          type: 'showImage',
          presentationId: input.presentationId,
          resolvedSrc: active.resolvedSrc
        }];
      }
      case 'imageFailed':
        if (!currentInPhase(input.presentationId, 'loading')) return [];
        return failCurrent(input.presentationId);
      case 'externalDocumentPresented':
        return current ? beginPresentation(current.sourceKey, current.rawSrc) : [];
      case 'dispose':
        lifecycle = 'disposed';
        current = null;
        projected = { phase: 'none' };
        return [];
    }
  };

  return { getState, dispatch };
}
