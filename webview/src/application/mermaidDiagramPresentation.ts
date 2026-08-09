export type MermaidDiagramPresentationPhase =
  | 'idle'
  | 'pending'
  | 'ready'
  | 'error'
  | 'disposed';

export type MermaidDiagramPresentationState = {
  readonly phase: MermaidDiagramPresentationPhase;
  readonly presentationId: number | null;
  readonly source: string | null;
  readonly themeKey: string | null;
  readonly configKey: string | null;
};

export type MermaidDiagramPresentationInput =
  | {
      readonly type: 'present';
      readonly source: string;
      readonly themeKey: string;
      readonly configKey: string;
    }
  | { readonly type: 'renderSucceeded'; readonly presentationId: number; readonly svg: string }
  | { readonly type: 'renderFailed'; readonly presentationId: number; readonly error: string }
  | { readonly type: 'externalDocumentPresented' }
  | { readonly type: 'dispose' };

export type MermaidDiagramPresentationEffect =
  | { readonly type: 'showPending'; readonly presentationId: number }
  | {
      readonly type: 'renderDiagram';
      readonly presentationId: number;
      readonly source: string;
      readonly themeKey: string;
      readonly configKey: string;
    }
  | { readonly type: 'showDiagram'; readonly presentationId: number; readonly svg: string }
  | { readonly type: 'clearPresentation'; readonly presentationId: number }
  | {
      readonly type: 'showError';
      readonly presentationId: number;
      readonly source: string;
      readonly error: string;
    };

export type MermaidDiagramPresentationApplication = {
  getState(): MermaidDiagramPresentationState;
  dispatch(input: MermaidDiagramPresentationInput): readonly MermaidDiagramPresentationEffect[];
};

export type MermaidDiagramPresentationEffectExecution = {
  readonly completion?: Promise<MermaidDiagramPresentationInput | null>;
};

/** Application-owned seam implemented by deterministic and Editor adapters. */
export type MermaidDiagramPresentationEffectExecutor = {
  execute(
    effect: MermaidDiagramPresentationEffect
  ): MermaidDiagramPresentationEffectExecution;
  dispose(): void;
};

/** Owns correlation for one diagram presentation; rendering and DOM remain Adapter effects. */
export function createMermaidDiagramPresentationApplication(): MermaidDiagramPresentationApplication {
  let phase: MermaidDiagramPresentationPhase = 'idle';
  let sequence = 0;
  let presentationId: number | null = null;
  let source: string | null = null;
  let themeKey: string | null = null;
  let configKey: string | null = null;

  const getState = (): MermaidDiagramPresentationState => ({
    phase,
    presentationId,
    source,
    themeKey,
    configKey
  });

  const clear = (nextPhase: MermaidDiagramPresentationPhase): void => {
    phase = nextPhase;
    presentationId = null;
    source = null;
    themeKey = null;
    configKey = null;
  };

  const dispatch = (
    input: MermaidDiagramPresentationInput
  ): readonly MermaidDiagramPresentationEffect[] => {
    if (phase === 'disposed') return [];

    switch (input.type) {
      case 'present':
        presentationId = ++sequence;
        source = input.source;
        themeKey = input.themeKey;
        configKey = input.configKey;
        phase = 'pending';
        return [
          { type: 'showPending', presentationId },
          {
            type: 'renderDiagram',
            presentationId,
            source,
            themeKey,
            configKey
          }
        ];
      case 'renderSucceeded':
        if (phase !== 'pending' || input.presentationId !== presentationId) return [];
        phase = 'ready';
        return [{ type: 'showDiagram', presentationId: input.presentationId, svg: input.svg }];
      case 'renderFailed':
        if (phase !== 'pending' || input.presentationId !== presentationId || source === null) return [];
        phase = 'error';
        return [{
          type: 'showError',
          presentationId: input.presentationId,
          source,
          error: input.error
        }];
      case 'externalDocumentPresented':
        if (presentationId === null) return [];
        const invalidatedPresentationId = presentationId;
        clear('idle');
        return [{ type: 'clearPresentation', presentationId: invalidatedPresentationId }];
      case 'dispose':
        clear('disposed');
        return [];
    }
  };

  return { getState, dispatch };
}
