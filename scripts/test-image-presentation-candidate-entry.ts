import {
  createImagePresentationApplication,
  type ImagePresentationApplication,
  type ImagePresentationEffect,
  type ImagePresentationInput
} from '../webview/src/application/imagePresentation';

type CandidateHarness = {
  create(root: HTMLElement): {
    dispatch(input: ImagePresentationInput): readonly ImagePresentationEffect[];
    state(): ReturnType<ImagePresentationApplication['getState']>;
    snapshot(): { className: string; text: string; src: string | null };
  };
  counts(): { applications: number; legacyWidgets: number };
};

let applications = 0;

const applyEffects = (root: HTMLElement, effects: readonly ImagePresentationEffect[]): void => {
  for (const effect of effects) {
    if (effect.type === 'showFallback') {
      root.className = 'candidate-image fallback';
      root.textContent = effect.sourceKey;
      continue;
    }
    if (effect.type === 'showImage') {
      const image = document.createElement('img');
      image.alt = 'candidate image';
      image.src = effect.resolvedSrc;
      root.className = 'candidate-image ready';
      root.replaceChildren(image);
      continue;
    }
    if (effect.type === 'cancelPresentation') {
      root.replaceChildren();
      root.className = 'candidate-image cancelled';
    }
  }
};

(globalThis as typeof globalThis & { ImagePresentationCandidate?: CandidateHarness })
  .ImagePresentationCandidate = {
    create(root) {
      applications += 1;
      const application = createImagePresentationApplication();
      return {
        dispatch(input) {
          const effects = application.dispatch(input);
          applyEffects(root, effects);
          return effects;
        },
        state: () => application.getState(),
        snapshot: () => ({
          className: root.className,
          text: root.textContent ?? '',
          src: root.querySelector('img')?.getAttribute('src') ?? null
        })
      };
    },
    counts: () => ({ applications, legacyWidgets: 0 })
  };
