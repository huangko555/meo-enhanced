import type { EditorView } from '@codemirror/view';

export interface ViewportElementAnchor {
  element: HTMLElement;
  top: number;
}

export interface ViewportDocumentAnchor {
  position: number;
  lineOffset: number;
}

export interface ViewportScrollDelta {
  top?: number;
  left?: number;
}

interface ViewportControllerOptions {
  attachInteractions?: boolean;
  getMode?: () => 'live' | 'source';
}

interface ScrollPosition {
  top: number;
  left: number;
}

interface ScrollTarget {
  top?: number;
  left?: number;
}

interface StabilizeOptions {
  onSettled?: () => void;
  schedule?: 'immediate' | 'next-frame';
}

interface ActiveScrollTarget {
  changedSinceFrame: boolean;
  frameScheduled: boolean;
  generation: number;
  intent: 'navigate' | 'preserve' | 'user-scroll';
  position: ScrollPosition;
  remainingFrames: number;
  stableFrames: number;
}

interface TouchGestureStart {
  clientX: number;
  clientY: number;
  scroll: ScrollPosition;
}

const MAX_SETTLE_FRAMES = 8;
const REQUIRED_STABLE_FRAMES = 2;
const POSITION_EPSILON = 0.5;
const WHEEL_GESTURE_IDLE_MS = 250;
const controllerByDom = new WeakMap<HTMLElement, ViewportController>();

export function getViewportController(view: Pick<EditorView, 'dom'>): ViewportController | null {
  return controllerByDom.get(view.dom) ?? null;
}

export class ViewportController {
  private generation = 0;
  private destroyed = false;
  private interactionsAttached = false;
  private wheelTargetTop: number | null = null;
  private wheelTargetLeft: number | null = null;
  private lastWheelAt = Number.NEGATIVE_INFINITY;
  private lastTouchMoveAt = Number.NEGATIVE_INFINITY;
  private elementAnchorGeneration: number | null = null;
  private touchGestureStart: TouchGestureStart | null = null;
  private activeScrollTarget: ActiveScrollTarget | null = null;
  private readonly getMode: () => 'live' | 'source';
  private readonly onWheel = (event: WheelEvent) => this.handleWheel(event);
  private readonly onScroll = () => this.scheduleActiveScrollFrame();
  private readonly onInteraction = () => this.markInteraction();
  private readonly onTouchStart = (event: TouchEvent) => this.handleTouchStart(event);
  private readonly onTouchMove = (event: TouchEvent) => this.handleTouchMove(event);
  private readonly onTouchEnd = () => this.finishTouchGesture();

  constructor(
    private readonly view: EditorView,
    options: ViewportControllerOptions = {}
  ) {
    this.getMode = options.getMode ?? (() => 'live');
    controllerByDom.set(view.dom, this);
    if (options.attachInteractions !== false) {
      view.scrollDOM.addEventListener('wheel', this.onWheel, { passive: true });
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      view.scrollDOM.addEventListener('touchstart', this.onTouchStart, { passive: true });
      view.scrollDOM.addEventListener('touchmove', this.onTouchMove, { passive: true });
      view.scrollDOM.addEventListener('touchend', this.onTouchEnd, { passive: true });
      view.scrollDOM.addEventListener('touchcancel', this.onTouchEnd, { passive: true });
      view.scrollDOM.addEventListener('pointerdown', this.onInteraction, { passive: true });
      view.dom.addEventListener('keydown', this.onInteraction, true);
      this.interactionsAttached = true;
    }
  }

  markInteraction(): void {
    this.generation += 1;
    this.activeScrollTarget = null;
    this.resetWheelGesture();
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.touchGestureStart = null;
  }

  /** Reconciles after CodeMirror has finished its own height and scroll anchoring. */
  reconcileAfterEditorUpdate(): void {
    const activeTarget = this.activeScrollTarget;
    if (!this.isActiveScrollTargetValid(activeTarget)) return;
    if (this.writeScrollPosition(activeTarget.position)) {
      activeTarget.changedSinceFrame = true;
    }
  }

  navigateBy(delta: ViewportScrollDelta): void {
    this.markInteraction();
    const current = this.readScrollPosition();
    const target = this.resolveScrollTarget({
      top: current.top + (delta.top ?? 0),
      left: current.left + (delta.left ?? 0)
    }, current);
    this.writeScrollPosition(target);
    this.stabilizeScrollPosition(target, 'next-frame', 'navigate');
  }

  captureDocumentAnchor(): ViewportDocumentAnchor {
    const scrollTop = Math.max(0, this.view.scrollDOM.scrollTop);
    const lineBlock = this.view.lineBlockAtHeight(scrollTop);
    return {
      position: lineBlock.from,
      lineOffset: Math.max(0, scrollTop - lineBlock.top)
    };
  }

  getTopVisiblePosition(): { line: number; lineOffset: number } {
    const anchor = this.captureDocumentAnchor();
    return {
      line: this.view.state.doc.lineAt(anchor.position).number,
      lineOffset: anchor.lineOffset
    };
  }

  restoreDocumentAnchor(anchor: ViewportDocumentAnchor, onSettled?: () => void): void {
    if (this.isUserScrolling()) return;
    const position = Math.min(Math.max(0, anchor.position), this.view.state?.doc?.length ?? anchor.position);
    const lineOffset = Number.isFinite(anchor.lineOffset) ? Math.max(0, anchor.lineOffset) : 0;
    this.stabilize(
      () => ({ top: Math.max(0, this.view.lineBlockAt(position).top + lineOffset) }),
      { onSettled }
    );
  }

  restoreTopVisibleLine(
    lineNumber: number,
    lineOffset = 0,
    onSettled?: () => void
  ): void {
    const normalizedLine = Math.min(
      Math.max(1, Math.floor(Number.isFinite(lineNumber) ? lineNumber : 1)),
      this.view.state.doc.lines
    );
    const line = this.view.state.doc.line(normalizedLine);
    this.restoreDocumentAnchor({ position: line.from, lineOffset }, onSettled);
  }

  preserveDocumentAnchorWhileMutation(mutate: () => void): void {
    const anchor = this.captureDocumentAnchor();
    mutate();
    this.restoreDocumentAnchor(anchor);
  }

  preserveScrollPosition(mutate: () => void): void {
    const target = this.readScrollPosition();
    mutate();
    if (!this.isUserScrolling()) this.stabilizeScrollPosition(target, 'next-frame', 'preserve');
  }

  preservePositionWhileMutation(position: number, mutate: () => void): void {
    const targetPosition = Math.min(Math.max(0, position), this.view.state.doc.length);
    const beforeTop = this.view.coordsAtPos(targetPosition)?.top ?? null;
    mutate();
    if (beforeTop === null || this.isUserScrolling()) return;
    this.stabilize(() => {
      const afterTop = this.view.coordsAtPos(Math.min(targetPosition, this.view.state.doc.length))?.top ?? null;
      return afterTop === null ? null : {
        top: this.view.scrollDOM.scrollTop + afterTop - beforeTop
      };
    }, {
      schedule: 'next-frame'
    });
  }

  preserveElementAnchor(anchor: ViewportElementAnchor): void {
    if (this.isUserScrolling()) return;
    if (this.elementAnchorGeneration === this.generation) return;
    const generation = this.generation + 1;
    this.elementAnchorGeneration = generation;
    this.stabilize(() => {
      if (!anchor.element.isConnected) return null;
      return {
        top: this.view.scrollDOM.scrollTop + anchor.element.getBoundingClientRect().top - anchor.top
      };
    }, {
      onSettled: () => {
        if (this.elementAnchorGeneration === generation) this.elementAnchorGeneration = null;
      }
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.activeScrollTarget = null;
    this.elementAnchorGeneration = null;
    this.resetWheelGesture();
    controllerByDom.delete(this.view.dom);
    if (this.interactionsAttached) {
      this.view.scrollDOM.removeEventListener('wheel', this.onWheel);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.view.scrollDOM.removeEventListener('touchstart', this.onTouchStart);
      this.view.scrollDOM.removeEventListener('touchmove', this.onTouchMove);
      this.view.scrollDOM.removeEventListener('touchend', this.onTouchEnd);
      this.view.scrollDOM.removeEventListener('touchcancel', this.onTouchEnd);
      this.view.scrollDOM.removeEventListener('pointerdown', this.onInteraction);
      this.view.dom.removeEventListener('keydown', this.onInteraction, true);
      this.interactionsAttached = false;
    }
  }

  private stabilize(readTarget: () => ScrollTarget | null, options: StabilizeOptions = {}): void {
    const generation = ++this.generation;
    this.activeScrollTarget = null;
    let attempts = 0;
    let stableFrames = 0;
    const finish = () => {
      if (options.onSettled) requestAnimationFrame(() => {
        if (!this.destroyed && generation === this.generation) options.onSettled?.();
      });
    };

    const measure = () => {
      if (this.destroyed || generation !== this.generation || attempts >= MAX_SETTLE_FRAMES) return;
      attempts += 1;
      this.view.requestMeasure({
        read: () => {
          if (this.destroyed || generation !== this.generation) return null;
          const requested = readTarget();
          return requested === null
            ? null
            : this.resolveScrollTarget(requested, this.readScrollPosition());
        },
        write: (target) => {
          if (this.destroyed || generation !== this.generation) return;
          if (!target) {
            finish();
            return;
          }
          queueMicrotask(() => {
            if (this.destroyed || generation !== this.generation) return;
            const changed = this.writeScrollPosition(target);
            stableFrames = changed ? 0 : stableFrames + 1;
            if (stableFrames >= REQUIRED_STABLE_FRAMES || attempts >= MAX_SETTLE_FRAMES) {
              finish();
              return;
            }
            requestAnimationFrame(measure);
          });
        }
      });
    };

    if (options.schedule === 'next-frame') requestAnimationFrame(measure);
    else measure();
  }

  private stabilizeScrollPosition(
    target: ScrollPosition,
    schedule: 'after-scroll' | 'next-frame',
    intent: ActiveScrollTarget['intent']
  ): void {
    const generation = ++this.generation;
    const activeTarget: ActiveScrollTarget = {
      changedSinceFrame: false,
      frameScheduled: false,
      generation,
      intent,
      position: target,
      remainingFrames: MAX_SETTLE_FRAMES,
      stableFrames: 0
    };
    this.activeScrollTarget = activeTarget;
    // Native wheel/trackpad scrolling owns the first write. Its scroll event
    // schedules reconciliation after the browser and CodeMirror have moved.
    if (schedule === 'next-frame') this.scheduleActiveScrollFrame();
  }

  private scheduleActiveScrollFrame(): void {
    const activeTarget = this.activeScrollTarget;
    if (!this.isActiveScrollTargetValid(activeTarget) || activeTarget.frameScheduled) return;
    activeTarget.frameScheduled = true;
    requestAnimationFrame(() => {
      activeTarget.frameScheduled = false;
      if (!this.isActiveScrollTargetValid(activeTarget)) return;
      activeTarget.remainingFrames -= 1;
      const changed = this.writeScrollPosition(activeTarget.position);
      activeTarget.stableFrames = changed || activeTarget.changedSinceFrame
        ? 0
        : activeTarget.stableFrames + 1;
      activeTarget.changedSinceFrame = false;
      if (activeTarget.stableFrames >= REQUIRED_STABLE_FRAMES || activeTarget.remainingFrames <= 0) {
        this.activeScrollTarget = null;
        return;
      }
      this.scheduleActiveScrollFrame();
    });
  }

  private isActiveScrollTargetValid(
    activeTarget: ActiveScrollTarget | null
  ): activeTarget is ActiveScrollTarget {
    if (
      activeTarget && !this.destroyed && activeTarget.generation === this.generation &&
      activeTarget.remainingFrames > 0
    ) return true;
    this.activeScrollTarget = null;
    return false;
  }

  private handleWheel(event: WheelEvent): void {
    if (this.getMode() !== 'live' || event.ctrlKey || (!event.deltaX && !event.deltaY)) {
      this.markInteraction();
      return;
    }

    const wheelAt = performance.now();
    const continuingGesture = wheelAt - this.lastWheelAt <= WHEEL_GESTURE_IDLE_MS;
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? Math.max(16, this.view.defaultLineHeight)
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? this.view.scrollDOM.clientHeight
        : 1;
    const current = this.readScrollPosition();
    const target = this.resolveScrollTarget({
      top: (continuingGesture && this.wheelTargetTop !== null ? this.wheelTargetTop : current.top) +
        event.deltaY * deltaScale,
      left: (continuingGesture && this.wheelTargetLeft !== null ? this.wheelTargetLeft : current.left) +
        event.deltaX * deltaScale
    }, current);

    this.wheelTargetTop = target.top;
    this.wheelTargetLeft = target.left;
    this.lastWheelAt = wheelAt;
    this.stabilizeScrollPosition(target, 'after-scroll', 'user-scroll');
  }

  private handleTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    this.markInteraction();
    if (this.getMode() !== 'live' || !touch) return;
    this.lastTouchMoveAt = performance.now();
    this.touchGestureStart = {
      clientX: touch.clientX,
      clientY: touch.clientY,
      scroll: this.readScrollPosition()
    };
  }

  private handleTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    const start = this.touchGestureStart;
    if (this.getMode() !== 'live' || !touch || !start) {
      this.markInteraction();
      return;
    }
    this.lastTouchMoveAt = performance.now();
    const current = this.readScrollPosition();
    const target = this.resolveScrollTarget({
      top: start.scroll.top + start.clientY - touch.clientY,
      left: start.scroll.left + start.clientX - touch.clientX
    }, current);
    this.stabilizeScrollPosition(target, 'after-scroll', 'user-scroll');
  }

  private finishTouchGesture(): void {
    this.generation += 1;
    this.activeScrollTarget = null;
    this.touchGestureStart = null;
    this.lastTouchMoveAt = performance.now();
  }

  private readScrollPosition(): ScrollPosition {
    return {
      top: this.view.scrollDOM.scrollTop,
      left: this.view.scrollDOM.scrollLeft
    };
  }

  private resolveScrollTarget(target: ScrollTarget, fallback: ScrollPosition): ScrollPosition {
    const maxTop = Math.max(0, this.view.scrollDOM.scrollHeight - this.view.scrollDOM.clientHeight);
    const maxLeft = Math.max(0, this.view.scrollDOM.scrollWidth - this.view.scrollDOM.clientWidth);
    return {
      top: Math.max(0, Math.min(maxTop, target.top ?? fallback.top)),
      left: Math.max(0, Math.min(maxLeft, target.left ?? fallback.left))
    };
  }

  private writeScrollPosition(target: ScrollPosition): boolean {
    const current = this.readScrollPosition();
    const topChanged = Math.abs(current.top - target.top) > POSITION_EPSILON;
    const leftChanged = Math.abs(current.left - target.left) > POSITION_EPSILON;
    if (topChanged) this.view.scrollDOM.scrollTop = target.top;
    if (leftChanged) this.view.scrollDOM.scrollLeft = target.left;
    return topChanged || leftChanged;
  }

  private resetWheelGesture(): void {
    this.wheelTargetTop = null;
    this.wheelTargetLeft = null;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
  }

  private isUserScrolling(): boolean {
    return this.activeScrollTarget?.intent === 'user-scroll' ||
      performance.now() - Math.max(this.lastWheelAt, this.lastTouchMoveAt) <= WHEEL_GESTURE_IDLE_MS;
  }
}
