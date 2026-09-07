import type { EditorView, ViewUpdate } from '@codemirror/view';
import { isLiveInputDerivedWorkRefresh } from './liveInputDerivedWork';

export type InteractionContinuityViewport = {
  revealCaret(
    position: number,
    isCurrent: () => boolean,
    withComfortBand: boolean
  ): void;
};

export type EditorInteractionContinuity = {
  observe(update: ViewUpdate): void;
  cancel(): void;
  dispose(): void;
};

export type NestedEditorInteractionContinuityViewport = {
  readBounds(): { top: number; bottom: number };
  revealCaret(
    caret: { top: number; bottom: number },
    isCurrent: () => boolean
  ): void;
};

type ActiveInput = {
  generation: number;
  position: number;
  awaitingDerivedPresentation: boolean;
  frame: number | null;
  remainingFrames: number;
  stableFrames: number;
};

type ActiveMainInput = ActiveInput & {
  scrollTopBeforeInput: number;
  viewportMoved: boolean;
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
  let active: ActiveMainInput | null = null;
  let pendingScrollTopBeforeInput: number | null = null;
  let disposed = false;

  const cancel = (): void => {
    nextGeneration += 1;
    if (active?.frame !== null && active?.frame !== undefined) {
      cancelAnimationFrame(active.frame);
    }
    active = null;
    pendingScrollTopBeforeInput = null;
  };

  const isCurrent = (candidate: ActiveMainInput): boolean => (
    !disposed && active === candidate && candidate.generation === nextGeneration
  );

  const schedule = (candidate: ActiveMainInput): void => {
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
          const comfortMargin = Math.max(0, view.defaultLineHeight);
          return {
            position,
            visible: Boolean(coords && coords.top >= scroller.top && coords.bottom <= scroller.bottom),
            comfortablyVisible: Boolean(
              coords &&
              coords.top >= scroller.top + comfortMargin &&
              coords.bottom <= scroller.bottom - comfortMargin
            ),
            viewportMoved: candidate.viewportMoved || (
              Math.abs(view.scrollDOM.scrollTop - candidate.scrollTopBeforeInput) > 0.5
            )
          };
        },
        write: (measurement) => {
          if (!measurement || !isCurrent(candidate)) return;
          candidate.remainingFrames -= 1;
          candidate.viewportMoved = measurement.viewportMoved;
          const needsComfortReveal = (
            measurement.viewportMoved && !measurement.comfortablyVisible
          );
          if (!measurement.visible || needsComfortReveal) {
            candidate.stableFrames = 0;
            viewport.revealCaret(
              measurement.position,
              () => isCurrent(candidate),
              needsComfortReveal
            );
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
    const scrollTopBeforeInput = (
      pendingScrollTopBeforeInput ?? view.scrollDOM.scrollTop
    );
    pendingScrollTopBeforeInput = null;
    cancel();
    const candidate: ActiveMainInput = {
      generation: nextGeneration,
      position: view.state.selection.main.head,
      scrollTopBeforeInput,
      viewportMoved: false,
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

  const captureScrollTopBeforeInput = (): void => {
    pendingScrollTopBeforeInput = (
      getMode() === 'live' && view.hasFocus
        ? view.scrollDOM.scrollTop
        : null
    );
  };
  const cancelOnInteraction = () => cancel();
  view.dom.addEventListener('beforeinput', captureScrollTopBeforeInput, true);
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
      view.dom.removeEventListener('beforeinput', captureScrollTopBeforeInput, true);
      view.scrollDOM.removeEventListener('wheel', cancelOnInteraction, true);
      view.scrollDOM.removeEventListener('touchstart', cancelOnInteraction, true);
      view.dom.removeEventListener('pointerdown', cancelOnInteraction, true);
      view.dom.removeEventListener('blur', cancelOnInteraction, true);
    }
  };
}

/**
 * Keeps a focused editor embedded in a Live block visible through wrapping and
 * outer-widget remeasurement. The outer viewport remains the sole scroll owner;
 * nested editors only report their caret geometry here.
 */
export function createNestedEditorInteractionContinuity(input: {
  readonly view: EditorView;
  readonly viewport: NestedEditorInteractionContinuityViewport;
  readonly isActive: () => boolean;
  readonly interactionTarget?: HTMLElement;
}): EditorInteractionContinuity {
  const { view, viewport, isActive, interactionTarget } = input;
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
      if (!isCurrent(candidate) || !isActive() || !view.hasFocus) {
        cancel();
        return;
      }
      view.requestMeasure({
        read: () => {
          if (!isCurrent(candidate)) return null;
          const position = Math.max(0, Math.min(candidate.position, view.state.doc.length));
          const coords = view.coordsAtPos(position);
          if (!coords) return null;
          const bounds = viewport.readBounds();
          return {
            caret: { top: coords.top, bottom: coords.bottom },
            visible: coords.top >= bounds.top && coords.bottom <= bounds.bottom
          };
        },
        write: (measurement) => {
          if (!measurement || !isCurrent(candidate)) return;
          candidate.remainingFrames -= 1;
          if (!measurement.visible) {
            candidate.stableFrames = 0;
            viewport.revealCaret(measurement.caret, () => isCurrent(candidate));
          } else {
            candidate.stableFrames += 1;
          }
          if (candidate.remainingFrames <= 0 || candidate.stableFrames >= REQUIRED_STABLE_FRAMES) {
            active = null;
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
      awaitingDerivedPresentation: false,
      frame: null,
      remainingFrames: MAX_SETTLE_FRAMES,
      stableFrames: 0
    };
    active = candidate;
    schedule(candidate);
  };

  const cancelOnInteraction = () => cancel();
  interactionTarget?.addEventListener('wheel', cancelOnInteraction, { capture: true, passive: true });
  interactionTarget?.addEventListener('touchstart', cancelOnInteraction, { capture: true, passive: true });
  view.dom.addEventListener('pointerdown', cancelOnInteraction, true);
  view.dom.addEventListener('blur', cancelOnInteraction, true);

  return {
    observe(update) {
      if (disposed) return;
      const directInput = update.transactions.some((transaction) => (
        transaction.docChanged && transaction.isUserEvent('input')
      ));
      if (directInput && isActive() && view.hasFocus && view.state.selection.main.empty) {
        beginInputSettlement();
      } else if (update.selectionSet && !directInput) {
        cancel();
      }
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      interactionTarget?.removeEventListener('wheel', cancelOnInteraction, true);
      interactionTarget?.removeEventListener('touchstart', cancelOnInteraction, true);
      view.dom.removeEventListener('pointerdown', cancelOnInteraction, true);
      view.dom.removeEventListener('blur', cancelOnInteraction, true);
    }
  };
}
