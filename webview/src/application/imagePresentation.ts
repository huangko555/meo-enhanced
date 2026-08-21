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

export type ImageProjectionTarget = Exclude<ImageProjectedPresentation, { readonly phase: 'none' }>;

export type ImageProjectionIntent = {
  readonly commandId: number;
  readonly target: ImageProjectionTarget;
};

export type ImagePresentationState = {
  readonly lifecycle: 'active' | 'disposed';
  /** Latest resolve/load work; ready does not imply that its DOM projection succeeded. */
  readonly current: ImagePresentationCurrent | null;
  /** Last projection confirmed by a correlated success acknowledgement. */
  readonly projected: ImageProjectedPresentation;
  /** The only projection command whose acknowledgement can still change projected. */
  readonly projection: ImageProjectionIntent | null;
};

export type ImagePresentationInput =
  | { readonly type: 'present'; readonly sourceKey: string; readonly rawSrc: string }
  | { readonly type: 'sourceResolved'; readonly presentationId: number; readonly resolvedSrc: string }
  | { readonly type: 'sourceFailed'; readonly presentationId: number }
  | { readonly type: 'imageLoaded'; readonly presentationId: number }
  | { readonly type: 'imageFailed'; readonly presentationId: number }
  | {
      readonly type: 'projectionSucceeded' | 'projectionFailed';
      readonly presentationId: number;
      readonly commandId: number;
    }
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
      readonly commandId: number;
      readonly resolvedSrc: string;
    }
  | {
      readonly type: 'showFallback';
      readonly presentationId: number;
      readonly commandId: number;
      readonly sourceKey: string;
    };

export type ImagePresentationApplication = {
  getState(): ImagePresentationState;
  dispatch(input: ImagePresentationInput): readonly ImagePresentationEffect[];
};

export type ImagePresentationEffectExecution =
  | { readonly immediateCompletion: ImagePresentationInput }
  | { readonly completion: Promise<ImagePresentationInput> };

export type ImagePresentationEffectContext = {
  /** Re-checks Application correlation immediately before a deferred DOM mutation. */
  isCurrentProjection(): boolean;
};

/** Application-owned port implemented by deterministic and Editor adapters. */
export type ImagePresentationEffectExecutor = {
  execute(
    effect: ImagePresentationEffect,
    context: ImagePresentationEffectContext
  ): ImagePresentationEffectExecution;
  dispose(): void;
};

function sameProjectionTarget(
  left: ImageProjectionTarget,
  right: ImageProjectionTarget
): boolean {
  if (left.phase !== right.phase || left.presentationId !== right.presentationId) return false;
  if (left.phase === 'ready' && right.phase === 'ready') {
    return left.sourceKey === right.sourceKey && left.resolvedSrc === right.resolvedSrc;
  }
  if (left.phase !== 'ready' && right.phase !== 'ready') {
    return left.sourceKey === right.sourceKey;
  }
  return false;
}

function isFallbackTarget(target: ImageProjectionTarget): boolean {
  return target.phase === 'fallback' || target.phase === 'error';
}

/**
 * Owns latest resource work, confirmed DOM identity, and one correlated
 * projection command. Runtime and concrete DOM adapters only execute effects
 * and return completions; they never infer or retain projected identity.
 */
export function createImagePresentationApplication(): ImagePresentationApplication {
  let lifecycle: ImagePresentationState['lifecycle'] = 'active';
  let presentationSequence = 0;
  let commandSequence = 0;
  let current: ImagePresentationCurrent | null = null;
  let projected: ImageProjectedPresentation = { phase: 'none' };
  let projection: ImageProjectionIntent | null = null;

  const getState = (): ImagePresentationState => ({ lifecycle, current, projected, projection });

  const currentInPhase = (
    candidateId: number,
    expectedPhase: ImagePresentationWorkPhase
  ): ImagePresentationCurrent | null => (
    current?.presentationId === candidateId && current.phase === expectedPhase
      ? current
      : null
  );

  const requiredProjection = (): ImageProjectionTarget | null => {
    if (!current) return null;
    if (current.phase === 'ready' && current.resolvedSrc) {
      return {
        phase: 'ready',
        presentationId: current.presentationId,
        sourceKey: current.sourceKey,
        resolvedSrc: current.resolvedSrc
      };
    }
    if (current.phase === 'error') {
      return {
        phase: 'error',
        presentationId: current.presentationId,
        sourceKey: current.sourceKey
      };
    }
    if (projected.phase !== 'ready') {
      return {
        phase: 'fallback',
        presentationId: current.presentationId,
        sourceKey: current.sourceKey
      };
    }
    return null;
  };

  const projectionEffect = (intent: ImageProjectionIntent): ImagePresentationEffect => (
    intent.target.phase === 'ready'
      ? {
          type: 'showImage',
          presentationId: intent.target.presentationId,
          commandId: intent.commandId,
          resolvedSrc: intent.target.resolvedSrc
        }
      : {
          type: 'showFallback',
          presentationId: intent.target.presentationId,
          commandId: intent.commandId,
          sourceKey: intent.target.sourceKey
        }
  );

  const requestRequiredProjection = (
    rejectedTarget: ImageProjectionTarget | null = null
  ): readonly ImagePresentationEffect[] => {
    const target = requiredProjection();
    if (!target) return [];
    if (projection) {
      if (
        isFallbackTarget(projection.target) &&
        isFallbackTarget(target) &&
        projection.target.presentationId === target.presentationId &&
        projection.target.sourceKey === target.sourceKey
      ) {
        projection = { ...projection, target };
      }
      return [];
    }
    if (projected.phase !== 'none' && sameProjectionTarget(projected, target)) return [];
    if (rejectedTarget && sameProjectionTarget(rejectedTarget, target)) return [];
    projection = { commandId: ++commandSequence, target };
    return [projectionEffect(projection)];
  };

  const beginPresentation = (
    sourceKey: string,
    rawSrc: string
  ): readonly ImagePresentationEffect[] => {
    const presentationId = ++presentationSequence;
    current = {
      phase: 'resolving',
      presentationId,
      sourceKey,
      rawSrc,
      resolvedSrc: null
    };
    return [
      ...requestRequiredProjection(),
      { type: 'resolveSource', presentationId, rawSrc }
    ];
  };

  const failCurrent = (): readonly ImagePresentationEffect[] => {
    if (!current) return [];
    current = { ...current, phase: 'error', resolvedSrc: null };
    if (
      projected.phase === 'fallback' &&
      projected.presentationId === current.presentationId &&
      projected.sourceKey === current.sourceKey
    ) {
      // The fallback DOM was already acknowledged for this presentation. Its
      // terminal classification can change without issuing the same DOM command twice.
      projected = {
        phase: 'error',
        presentationId: current.presentationId,
        sourceKey: current.sourceKey
      };
      return [];
    }
    return requestRequiredProjection();
  };

  const acknowledgeProjection = (
    input: Extract<ImagePresentationInput, { type: 'projectionSucceeded' | 'projectionFailed' }>
  ): readonly ImagePresentationEffect[] => {
    if (
      projection?.commandId !== input.commandId ||
      projection.target.presentationId !== input.presentationId
    ) {
      return [];
    }
    const completed = projection;
    projection = null;
    if (input.type === 'projectionSucceeded' && current?.presentationId === input.presentationId) {
      projected = completed.target;
      return requestRequiredProjection();
    }
    return requestRequiredProjection(completed.target);
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
        return failCurrent();
      case 'imageLoaded': {
        const active = currentInPhase(input.presentationId, 'loading');
        if (!active || active.resolvedSrc === null) return [];
        current = { ...active, phase: 'ready' };
        return requestRequiredProjection();
      }
      case 'imageFailed':
        if (!currentInPhase(input.presentationId, 'loading')) return [];
        return failCurrent();
      case 'projectionSucceeded':
      case 'projectionFailed':
        return acknowledgeProjection(input);
      case 'externalDocumentPresented':
        return current ? beginPresentation(current.sourceKey, current.rawSrc) : [];
      case 'dispose':
        lifecycle = 'disposed';
        current = null;
        projected = { phase: 'none' };
        projection = null;
        return [];
    }
  };

  return { getState, dispatch };
}
