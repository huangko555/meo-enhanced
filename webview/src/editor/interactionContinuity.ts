import type { EditorView, ViewUpdate } from '@codemirror/view';
import { isLiveInputDerivedWorkRefresh } from './liveInputDerivedWork';

export type InteractionContinuityViewport = {
  retainCaretTop(
    position: number,
    top: number,
    isCurrent: () => boolean
  ): void;
  revealCaret(
    position: number,
    isCurrent: () => boolean,
    originScrollTop: number
  ): void;
};

export type EditorInteractionContinuity = {
  observe(update: ViewUpdate): void;
  cancel(): void;
  dispose(): void;
};

export type NestedEditorInteractionContinuityViewport = {
  readBounds(): { top: number; bottom: number };
  readScrollTop(): number;
  revealCaret(
    position: number,
    isCurrent: () => boolean,
    originScrollTop: number
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
  caretTopBeforeInput: number | null;
  inputLineHeightBefore: number | null;
  inputLineNumberBefore: number | null;
  retainingCaretTop: boolean;
  scrollTopBeforeInput: number;
  viewportMoved: boolean;
};

type ActiveNestedInput = ActiveInput & {
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
  let pendingCaretTopBeforeInput: number | null = null;
  let pendingInputLineHeight: number | null = null;
  let pendingInputLineNumber: number | null = null;
  let inputSessionScrollTop: number | null = null;
  let inputSessionCaretTop: number | null = null;
  let inputSessionPosition: number | null = null;
  let disposed = false;

  const cancelActive = (): void => {
    nextGeneration += 1;
    if (active?.frame !== null && active?.frame !== undefined) {
      cancelAnimationFrame(active.frame);
    }
    active = null;
  };

  const cancel = (): void => {
    cancelActive();
    pendingScrollTopBeforeInput = null;
    pendingCaretTopBeforeInput = null;
    pendingInputLineHeight = null;
    pendingInputLineNumber = null;
    inputSessionScrollTop = null;
    inputSessionCaretTop = null;
    inputSessionPosition = null;
  };

  const isCurrent = (candidate: ActiveMainInput): boolean => (
    !disposed && active === candidate && candidate.generation === nextGeneration
  );

  const schedule = (candidate: ActiveMainInput, immediate = false): void => {
    if (!isCurrent(candidate) || candidate.frame !== null) return;
    const measure = () => {
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
            caretTop: coords?.top ?? null,
            inputLineHeight: view.lineBlockAt(position).height,
            inputLineNumber: view.state.doc.lineAt(position).number,
            position,
            visible: Boolean(coords && coords.top >= scroller.top && coords.bottom <= scroller.bottom),
            viewportMoved: candidate.viewportMoved || (
              Math.abs(view.scrollDOM.scrollTop - candidate.scrollTopBeforeInput) > 0.5
            )
          };
        },
        write: (measurement) => {
          if (!measurement || !isCurrent(candidate)) return;
          candidate.remainingFrames -= 1;
          candidate.viewportMoved = measurement.viewportMoved;
          const inputLineReflowed = (
            candidate.inputLineHeightBefore !== null &&
            Math.abs(measurement.inputLineHeight - candidate.inputLineHeightBefore) > 0.5
          ) || (
            candidate.inputLineNumberBefore !== null &&
            measurement.inputLineNumber !== candidate.inputLineNumberBefore
          );
          if (inputLineReflowed && measurement.caretTop !== null) {
            // The caret moved because the edited line wrapped or changed lines,
            // not because an upstream layout correction displaced the viewport.
            candidate.caretTopBeforeInput = measurement.caretTop;
            inputSessionCaretTop = measurement.caretTop;
            candidate.retainingCaretTop = false;
            candidate.inputLineHeightBefore = measurement.inputLineHeight;
            candidate.inputLineNumberBefore = measurement.inputLineNumber;
          }
          const largeLayoutShift = (
            candidate.caretTopBeforeInput !== null && measurement.caretTop !== null &&
            Math.abs(measurement.caretTop - candidate.caretTopBeforeInput) > view.defaultLineHeight * 1.5
          );
          candidate.retainingCaretTop ||= largeLayoutShift;
          if (candidate.retainingCaretTop && candidate.caretTopBeforeInput !== null) {
            if (
              measurement.caretTop !== null &&
              Math.abs(measurement.caretTop - candidate.caretTopBeforeInput) <= 0.5
            ) {
              candidate.stableFrames += 1;
            } else {
              candidate.stableFrames = 0;
              viewport.retainCaretTop(
                measurement.position,
                candidate.caretTopBeforeInput,
                () => isCurrent(candidate)
              );
            }
          } else if (!measurement.visible || measurement.viewportMoved) {
            candidate.stableFrames = 0;
            viewport.revealCaret(
              measurement.position,
              () => isCurrent(candidate),
              candidate.scrollTopBeforeInput
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
    };
    if (immediate) measure();
    else {
      candidate.frame = requestAnimationFrame(() => {
        candidate.frame = null;
        measure();
      });
    }
  };

  const beginInputSettlement = (): void => {
    // A burst of keyboard input is one viewport interaction. If an earlier
    // character triggered a delayed height-map correction, the next
    // `beforeinput` observes that transient scroll offset. Keep the original
    // baseline until the burst settles instead of ratcheting toward the drift.
    const scrollTopBeforeInput = (
      inputSessionScrollTop ?? pendingScrollTopBeforeInput ?? view.scrollDOM.scrollTop
    );
    const caretTopBeforeInput = inputSessionCaretTop
      ?? pendingCaretTopBeforeInput
      ?? view.coordsAtPos(view.state.selection.main.head)?.top
      ?? null;
    const inputLineHeightBefore = pendingInputLineHeight;
    const inputLineNumberBefore = pendingInputLineNumber;
    inputSessionScrollTop = scrollTopBeforeInput;
    inputSessionCaretTop = caretTopBeforeInput;
    pendingScrollTopBeforeInput = null;
    pendingCaretTopBeforeInput = null;
    pendingInputLineHeight = null;
    pendingInputLineNumber = null;
    cancelActive();
    const position = view.state.selection.main.head;
    inputSessionPosition = position;
    const candidate: ActiveMainInput = {
      generation: nextGeneration,
      position,
      caretTopBeforeInput,
      inputLineHeightBefore,
      inputLineNumberBefore,
      retainingCaretTop: false,
      scrollTopBeforeInput,
      viewportMoved: false,
      awaitingDerivedPresentation: true,
      frame: null,
      remainingFrames: MAX_SETTLE_FRAMES,
      stableFrames: 0
    };
    active = candidate;
    schedule(candidate, true);
  };

  const resumeAfterDerivedPresentation = (): void => {
    const candidate = active;
    if (!candidate) return;
    candidate.position = view.state.selection.main.head;
    candidate.awaitingDerivedPresentation = false;
    candidate.remainingFrames = MAX_SETTLE_FRAMES;
    candidate.stableFrames = 0;
    schedule(candidate, true);
  };

  const captureScrollTopBeforeInput = (): void => {
    const canCapture = getMode() === 'live' && view.hasFocus;
    const position = view.state.selection.main.head;
    pendingScrollTopBeforeInput = canCapture ? view.scrollDOM.scrollTop : null;
    pendingCaretTopBeforeInput = canCapture
      ? view.coordsAtPos(position)?.top ?? null
      : null;
    pendingInputLineHeight = canCapture ? view.lineBlockAt(position).height : null;
    pendingInputLineNumber = canCapture ? view.state.doc.lineAt(position).number : null;
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

      if (update.selectionSet) {
        const selection = view.state.selection.main;
        if (
          inputSessionPosition !== null && selection.empty &&
          selection.head === inputSessionPosition
        ) return;
        cancel();
      }
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
  let active: ActiveNestedInput | null = null;
  let pendingScrollTopBeforeInput: number | null = null;
  let inputSessionScrollTop: number | null = null;
  let inputSessionPosition: number | null = null;
  let disposed = false;

  const cancelActive = (): void => {
    nextGeneration += 1;
    if (active?.frame !== null && active?.frame !== undefined) {
      cancelAnimationFrame(active.frame);
    }
    active = null;
  };

  const cancel = (): void => {
    cancelActive();
    pendingScrollTopBeforeInput = null;
    inputSessionScrollTop = null;
    inputSessionPosition = null;
  };

  const isCurrent = (candidate: ActiveNestedInput): boolean => (
    !disposed && active === candidate && candidate.generation === nextGeneration
  );

  const schedule = (candidate: ActiveNestedInput): void => {
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
            position,
            visible: coords.top >= bounds.top && coords.bottom <= bounds.bottom,
            viewportMoved: candidate.viewportMoved || (
              Math.abs(viewport.readScrollTop() - candidate.scrollTopBeforeInput) > 0.5
            )
          };
        },
        write: (measurement) => {
          if (!measurement || !isCurrent(candidate)) return;
          candidate.remainingFrames -= 1;
          candidate.viewportMoved = measurement.viewportMoved;
          if (!measurement.visible || measurement.viewportMoved) {
            candidate.stableFrames = 0;
            viewport.revealCaret(
              measurement.position,
              () => isCurrent(candidate),
              candidate.scrollTopBeforeInput
            );
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
    const scrollTopBeforeInput = inputSessionScrollTop
      ?? pendingScrollTopBeforeInput
      ?? viewport.readScrollTop();
    inputSessionScrollTop = scrollTopBeforeInput;
    pendingScrollTopBeforeInput = null;
    cancelActive();
    const position = view.state.selection.main.head;
    inputSessionPosition = position;
    const candidate: ActiveNestedInput = {
      generation: nextGeneration,
      position,
      scrollTopBeforeInput,
      viewportMoved: false,
      awaitingDerivedPresentation: false,
      frame: null,
      remainingFrames: MAX_SETTLE_FRAMES,
      stableFrames: 0
    };
    active = candidate;
    schedule(candidate);
  };

  const captureScrollTopBeforeInput = (): void => {
    pendingScrollTopBeforeInput = isActive() && view.hasFocus
      ? viewport.readScrollTop()
      : null;
  };
  const cancelOnInteraction = () => cancel();
  view.dom.addEventListener('beforeinput', captureScrollTopBeforeInput, true);
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
        const selection = view.state.selection.main;
        if (
          inputSessionPosition === null || !selection.empty ||
          selection.head !== inputSessionPosition
        ) cancel();
      }
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      view.dom.removeEventListener('beforeinput', captureScrollTopBeforeInput, true);
      interactionTarget?.removeEventListener('wheel', cancelOnInteraction, true);
      interactionTarget?.removeEventListener('touchstart', cancelOnInteraction, true);
      view.dom.removeEventListener('pointerdown', cancelOnInteraction, true);
      view.dom.removeEventListener('blur', cancelOnInteraction, true);
    }
  };
}
