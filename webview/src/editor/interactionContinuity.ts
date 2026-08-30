import type { EditorView, ViewUpdate } from '@codemirror/view';
import { isLiveInputDerivedWorkRefresh } from './liveInputDerivedWork';

export type InteractionContinuityViewport = {
  revealCaret(position: number, isCurrent: () => boolean): void;
};

export type EditorInteractionContinuity = {
  observe(update: ViewUpdate): void;
  cancel(): void;
  dispose(): void;
};

type ActiveInput = {
  generation: number;
  position: number;
  awaitingDerivedPresentation: boolean;
  frame: number | null;
  remainingFrames: number;
  stableFrames: number;
};

const MAX_SETTLE_FRAMES = 8;
const REQUIRED_STABLE_FRAMES = 2;

/**
 * Owns the user's location across Live's two-phase text and presentation updates.
 * Text input keeps the viewport still while the caret is visible; once wrapping or
 * a derived decoration moves it outside, the caret takes ownership and is revealed
 * at the nearest edge. Explicit navigation and non-input interaction cancel the run.
 */
export function createEditorInteractionContinuity(input: {
  readonly view: EditorView;
  readonly viewport: InteractionContinuityViewport;
  readonly getMode: () => 'live' | 'source';
}): EditorInteractionContinuity {
  const { view, viewport, getMode } = input;
  let nextGeneration = 0;
  let active: ActiveInput | null = null;
  let disposed = false;

  const cancel = (): void => {
    nextGeneration += 1;
    if (active?.frame !== null && active?.frame !== undefined) {
      cancelAnimationFrame(active.frame);
    }
    active = null;
  };

  const isCurrent = (candidate: ActiveInput): boolean => (
    !disposed && active === candidate && candidate.generation === nextGeneration
  );

  const schedule = (candidate: ActiveInput): void => {
    if (!isCurrent(candidate) || candidate.frame !== null) return;
    candidate.frame = requestAnimationFrame(() => {
      candidate.frame = null;
      if (!isCurrent(candidate) || getMode() !== 'live' || !view.hasFocus) {
        cancel();
        return;
      }
      view.requestMeasure({
        read: () => {
          if (!isCurrent(candidate)) return null;
          const position = Math.max(0, Math.min(candidate.position, view.state.doc.length));
          const coords = view.coordsAtPos(position);
          const scroller = view.scrollDOM.getBoundingClientRect();
          return {
            position,
            visible: Boolean(coords && coords.top >= scroller.top && coords.bottom <= scroller.bottom)
          };
        },
        write: (measurement) => {
          if (!measurement || !isCurrent(candidate)) return;
          candidate.remainingFrames -= 1;
          if (!measurement.visible) {
            candidate.stableFrames = 0;
            viewport.revealCaret(measurement.position, () => isCurrent(candidate));
          } else {
            candidate.stableFrames += 1;
          }

          if (candidate.remainingFrames <= 0 || candidate.stableFrames >= REQUIRED_STABLE_FRAMES) {
            if (!candidate.awaitingDerivedPresentation) active = null;
            return;
          }
          schedule(candidate);
        }
      });
    });
  };

  const beginInputSettlement = (): void => {
    cancel();
    const candidate: ActiveInput = {
      generation: nextGeneration,
      position: view.state.selection.main.head,
      awaitingDerivedPresentation: true,
      frame: null,
      remainingFrames: MAX_SETTLE_FRAMES,
      stableFrames: 0
    };
    active = candidate;
    schedule(candidate);
  };

  const resumeAfterDerivedPresentation = (): void => {
    const candidate = active;
    if (!candidate) return;
    candidate.position = view.state.selection.main.head;
    candidate.awaitingDerivedPresentation = false;
    candidate.remainingFrames = MAX_SETTLE_FRAMES;
    candidate.stableFrames = 0;
    schedule(candidate);
  };

  const cancelOnInteraction = () => cancel();
  view.scrollDOM.addEventListener('wheel', cancelOnInteraction, { capture: true, passive: true });
  view.scrollDOM.addEventListener('touchstart', cancelOnInteraction, { capture: true, passive: true });
  view.dom.addEventListener('pointerdown', cancelOnInteraction, true);
  view.dom.addEventListener('blur', cancelOnInteraction, true);

  return {
    observe(update) {
      if (disposed) return;
      const directInput = update.transactions.some((transaction) => (
        transaction.docChanged && transaction.isUserEvent('input')
      ));
      if (directInput) {
        if (getMode() === 'live' && view.hasFocus && view.state.selection.main.empty) {
          beginInputSettlement();
        } else {
          cancel();
        }
        return;
      }

      if (update.transactions.some(isLiveInputDerivedWorkRefresh)) {
        resumeAfterDerivedPresentation();
        return;
      }

      if (update.selectionSet) cancel();
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      view.scrollDOM.removeEventListener('wheel', cancelOnInteraction, true);
      view.scrollDOM.removeEventListener('touchstart', cancelOnInteraction, true);
      view.dom.removeEventListener('pointerdown', cancelOnInteraction, true);
      view.dom.removeEventListener('blur', cancelOnInteraction, true);
    }
  };
}
