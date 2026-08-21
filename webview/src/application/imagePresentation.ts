export type ImagePresentationPhase =
  | 'idle'
  | 'resolving'
  | 'loading'
  | 'ready'
  | 'fallback'
  | 'disposed';

export type ImagePresentationState = {
  readonly phase: ImagePresentationPhase;
  readonly presentationId: number | null;
  readonly sourceKey: string | null;
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
 * Owns correlation and failure ordering for one rendered image presentation.
 * Resolution, browser loading, DOM projection and viewport preservation remain
 * concrete Editor-adapter effects.
 */
export function createImagePresentationApplication(): ImagePresentationApplication {
  let phase: ImagePresentationPhase = 'idle';
  let sequence = 0;
  let presentationId: number | null = null;
  let sourceKey: string | null = null;
  let rawSrc: string | null = null;
  let resolvedSrc: string | null = null;

  const getState = (): ImagePresentationState => ({ phase, presentationId, sourceKey });

  const isCurrent = (candidateId: number, expectedPhase: ImagePresentationPhase): boolean => (
    presentationId === candidateId && phase === expectedPhase
  );

  const clear = (nextPhase: ImagePresentationPhase): void => {
    phase = nextPhase;
    presentationId = null;
    sourceKey = null;
    rawSrc = null;
    resolvedSrc = null;
  };

  const beginPresentation = (
    nextSourceKey: string,
    nextRawSrc: string
  ): readonly ImagePresentationEffect[] => {
    const nextPresentationId = ++sequence;
    presentationId = nextPresentationId;
    sourceKey = nextSourceKey;
    rawSrc = nextRawSrc;
    resolvedSrc = null;
    phase = 'resolving';
    return [
      {
        type: 'showFallback',
        presentationId: nextPresentationId,
        sourceKey: nextSourceKey
      },
      {
        type: 'resolveSource',
        presentationId: nextPresentationId,
        rawSrc: nextRawSrc
      }
    ];
  };

  const dispatch = (input: ImagePresentationInput): readonly ImagePresentationEffect[] => {
    if (phase === 'disposed') return [];

    switch (input.type) {
      case 'present': {
        return beginPresentation(input.sourceKey, input.rawSrc);
      }
      case 'sourceResolved':
        if (!isCurrent(input.presentationId, 'resolving') || !input.resolvedSrc) return [];
        resolvedSrc = input.resolvedSrc;
        phase = 'loading';
        return [{ type: 'loadImage', presentationId: input.presentationId, resolvedSrc }];
      case 'sourceFailed':
        if (!isCurrent(input.presentationId, 'resolving') || sourceKey === null) return [];
        phase = 'fallback';
        return [{ type: 'showFallback', presentationId: input.presentationId, sourceKey }];
      case 'imageLoaded':
        if (!isCurrent(input.presentationId, 'loading') || resolvedSrc === null) return [];
        phase = 'ready';
        return [{ type: 'showImage', presentationId: input.presentationId, resolvedSrc }];
      case 'imageFailed':
        if (!isCurrent(input.presentationId, 'loading') || sourceKey === null) return [];
        resolvedSrc = null;
        phase = 'fallback';
        return [{ type: 'showFallback', presentationId: input.presentationId, sourceKey }];
      case 'externalDocumentPresented': {
        if (sourceKey === null || rawSrc === null) {
          clear('idle');
          return [];
        }
        return beginPresentation(sourceKey, rawSrc);
      }
      case 'dispose': {
        clear('disposed');
        return [];
      }
    }
  };

  return { getState, dispatch };
}
