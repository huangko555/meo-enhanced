import type { EditorView } from '@codemirror/view';

export interface ViewportDocumentAnchor {
  position: number;
  lineOffset: number;
}

type RestoreDocumentAnchorOptions = {
  force?: boolean;
};

export interface ViewportScrollDelta {
  top?: number;
  left?: number;
}

export interface ViewportLayoutRegion {
  element: HTMLElement;
  from: number;
  to: number;
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

interface LayoutAnchor {
  position: number;
  viewportOffset: number;
}

interface ActiveLayoutAnchor extends LayoutAnchor {
  frameScheduled: boolean;
  remainingFrames: number;
  revision: number;
  stableFrames: number;
}

interface StabilizeOptions {
  onSettled?: () => void;
  schedule?: 'immediate' | 'next-frame';
}

interface ActiveScrollTarget {
  changedSinceFrame: boolean;
  frameScheduled: boolean;
  generation: number;
  position: ScrollPosition;
  remainingFrames: number;
  stableFrames: number;
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
  private lastWheelAt = Number.NEGATIVE_INFINITY;
  private lastTouchMoveAt = Number.NEGATIVE_INFINITY;
  private lastScrollDirection: -1 | 0 | 1 = 0;
  private interactionGeneration = 0;
  private activeScrollTarget: ActiveScrollTarget | null = null;
  private activeLayoutAnchor: ActiveLayoutAnchor | null = null;
  private anchorStabilizationGeneration: number | null = null;
  private lastTouchY: number | null = null;
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
    this.interactionGeneration += 1;
    this.generation += 1;
    this.activeScrollTarget = null;
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = null;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.lastTouchY = null;
  }

  preserveLayoutChange(region: ViewportLayoutRegion, mutate: () => void): void {
    if (this.destroyed || !region.element.isConnected) {
      mutate();
      return;
    }
    this.view.requestMeasure({
      read: () => {
        const from = Math.min(region.from, region.to);
        const to = Math.max(region.from, region.to);
        const activeAnchor = this.activeLayoutAnchor;
        return {
          anchor: activeAnchor && (activeAnchor.position < from || activeAnchor.position > to)
            ? { position: activeAnchor.position, viewportOffset: activeAnchor.viewportOffset }
            : this.captureLayoutAnchor(region),
          from,
          interactionGeneration: this.interactionGeneration,
          to
        };
      },
      write: ({ anchor, from, interactionGeneration, to }) => {
        mutate();
        if (!anchor || interactionGeneration !== this.interactionGeneration) {
          this.view.requestMeasure();
          return;
        }
        if (this.hasActiveDocumentAnchorStabilization()) {
          this.view.requestMeasure();
          return;
        }
        if (this.activeScrollTarget?.generation === this.generation) {
          this.generation += 1;
          this.activeScrollTarget = null;
        }
        const activeAnchor = this.activeLayoutAnchor;
        if (!activeAnchor || (activeAnchor.position >= from && activeAnchor.position <= to)) {
          this.activeLayoutAnchor = {
            ...anchor,
            frameScheduled: false,
            remainingFrames: MAX_SETTLE_FRAMES,
            revision: 0,
            stableFrames: 0
          };
        }
        this.restartLayoutStabilization();
      }
    });
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
    this.stabilizeScrollPosition(target);
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

  restoreDocumentAnchor(
    anchor: ViewportDocumentAnchor,
    onSettled?: () => void,
    { force = false }: RestoreDocumentAnchorOptions = {}
  ): void {
    if (!force && this.isUserScrolling()) return;
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
    onSettled?: () => void,
    options: RestoreDocumentAnchorOptions = {}
  ): void {
    const normalizedLine = Math.min(
      Math.max(1, Math.floor(Number.isFinite(lineNumber) ? lineNumber : 1)),
      this.view.state.doc.lines
    );
    const line = this.view.state.doc.line(normalizedLine);
    this.restoreDocumentAnchor({ position: line.from, lineOffset }, onSettled, options);
  }

  preserveDocumentAnchorWhileMutation(mutate: () => void): void {
    const anchor = this.captureDocumentAnchor();
    mutate();
    this.restoreDocumentAnchor(anchor);
  }

  preserveScrollPosition(mutate: () => void): void {
    const anchor = this.captureDocumentAnchor();
    const left = this.view.scrollDOM.scrollLeft;
    mutate();
    if (this.isUserScrolling()) return;
    this.stabilize(() => ({
      left,
      top: Math.max(0, this.view.lineBlockAt(anchor.position).top + anchor.lineOffset)
    }), {
      schedule: 'next-frame'
    });
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

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.activeScrollTarget = null;
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = null;
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
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = generation;
    let attempts = 0;
    let stableFrames = 0;
    const finish = () => {
      if (this.anchorStabilizationGeneration === generation) {
        this.anchorStabilizationGeneration = null;
      }
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

  private stabilizeScrollPosition(target: ScrollPosition): void {
    const generation = ++this.generation;
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = null;
    const activeTarget: ActiveScrollTarget = {
      changedSinceFrame: false,
      frameScheduled: false,
      generation,
      position: target,
      remainingFrames: MAX_SETTLE_FRAMES,
      stableFrames: 0
    };
    this.activeScrollTarget = activeTarget;
    this.scheduleActiveScrollFrame();
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

  private hasActiveDocumentAnchorStabilization(): boolean {
    return this.anchorStabilizationGeneration === this.generation;
  }

  private handleWheel(event: WheelEvent): void {
    if (this.getMode() !== 'live' || event.ctrlKey || (!event.deltaX && !event.deltaY)) {
      this.markInteraction();
      return;
    }
    this.generation += 1;
    this.activeScrollTarget = null;
    this.lastWheelAt = performance.now();
    this.lastScrollDirection = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : this.lastScrollDirection;
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? Math.max(16, this.view.defaultLineHeight)
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? this.view.scrollDOM.clientHeight
        : 1;
    const current = this.readScrollPosition();
    const expected = this.resolveScrollTarget({ top: current.top + event.deltaY * deltaScale }, current);
    this.mergeNativeScrollIntoLayoutAnchor(expected.top - current.top);
  }

  private handleTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    if (this.getMode() !== 'live' || !touch) {
      this.markInteraction();
      return;
    }
    this.generation += 1;
    this.activeScrollTarget = null;
    this.lastTouchMoveAt = performance.now();
    this.lastTouchY = touch.clientY;
  }

  private handleTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (this.getMode() !== 'live' || !touch) {
      this.markInteraction();
      return;
    }
    this.generation += 1;
    this.activeScrollTarget = null;
    this.lastTouchMoveAt = performance.now();
    if (this.lastTouchY !== null) {
      const current = this.readScrollPosition();
      const expected = this.resolveScrollTarget({ top: current.top + this.lastTouchY - touch.clientY }, current);
      this.mergeNativeScrollIntoLayoutAnchor(expected.top - current.top);
    }
    this.lastTouchY = touch.clientY;
  }

  private finishTouchGesture(): void {
    this.generation += 1;
    this.activeScrollTarget = null;
    this.lastTouchMoveAt = performance.now();
    this.lastTouchY = null;
  }

  private readScrollPosition(): ScrollPosition {
    return {
      top: this.view.scrollDOM.scrollTop,
      left: this.view.scrollDOM.scrollLeft
    };
  }

  private captureLayoutAnchor(region: ViewportLayoutRegion): LayoutAnchor | null {
    const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
    const regionRect = region.element.getBoundingClientRect();
    if (regionRect.top >= scrollerRect.bottom) return null;

    const from = Math.min(region.from, region.to);
    const to = Math.max(region.from, region.to);
    const candidates = Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
      .map((line) => ({
        position: this.view.posAtDOM(line),
        top: line.getBoundingClientRect().top
      }))
      .filter((candidate) => (
        (candidate.position < from || candidate.position > to) &&
        candidate.top >= scrollerRect.top && candidate.top < scrollerRect.bottom
      ));
    if (candidates.length === 0) return null;

    let anchor: (typeof candidates)[number] | undefined;
    const scrollDirection = this.isUserScrolling() ? this.lastScrollDirection : 0;
    if (regionRect.bottom <= scrollerRect.top) {
      anchor = candidates[0];
    } else if (scrollDirection < 0) {
      anchor = candidates.find((candidate) => candidate.position > to) ?? candidates.at(-1);
    } else if (scrollDirection > 0) {
      anchor = candidates.slice().reverse().find((candidate) => candidate.position < from) ?? candidates[0];
    } else {
      const readingY = scrollerRect.top + scrollerRect.height * 0.25;
      anchor = candidates.reduce((closest, candidate) => (
        Math.abs(candidate.top - readingY) < Math.abs(closest.top - readingY) ? candidate : closest
      ));
    }
    return anchor ? {
      position: anchor.position,
      viewportOffset: anchor.top - scrollerRect.top
    } : null;
  }

  private restartLayoutStabilization(): void {
    const activeAnchor = this.activeLayoutAnchor;
    if (!activeAnchor) return;
    activeAnchor.remainingFrames = MAX_SETTLE_FRAMES;
    activeAnchor.stableFrames = 0;
    activeAnchor.revision += 1;
    this.scheduleLayoutMeasure();
  }

  private scheduleLayoutMeasure(): void {
    const activeAnchor = this.activeLayoutAnchor;
    if (!activeAnchor || activeAnchor.frameScheduled || activeAnchor.remainingFrames <= 0) return;
    activeAnchor.frameScheduled = true;
    this.view.requestMeasure({
      read: () => {
        const current = this.activeLayoutAnchor;
        if (!current || current !== activeAnchor) return null;
        return {
          revision: current.revision,
          target: this.resolveScrollTarget({
            top: this.view.lineBlockAt(current.position).top - current.viewportOffset
          }, this.readScrollPosition())
        };
      },
      write: (measurement) => {
        activeAnchor.frameScheduled = false;
        if (!measurement || this.activeLayoutAnchor !== activeAnchor) return;
        queueMicrotask(() => {
          if (
            this.activeLayoutAnchor !== activeAnchor ||
            measurement.revision !== activeAnchor.revision
          ) {
            this.scheduleLayoutMeasure();
            return;
          }
          activeAnchor.remainingFrames -= 1;
          const changed = this.writeScrollPosition(measurement.target);
          activeAnchor.stableFrames = changed ? 0 : activeAnchor.stableFrames + 1;
          if (
            activeAnchor.stableFrames >= REQUIRED_STABLE_FRAMES ||
            activeAnchor.remainingFrames <= 0
          ) {
            this.activeLayoutAnchor = null;
            return;
          }
          requestAnimationFrame(() => this.scheduleLayoutMeasure());
        });
      }
    });
  }

  private mergeNativeScrollIntoLayoutAnchor(deltaTop: number): void {
    const activeAnchor = this.activeLayoutAnchor;
    if (!activeAnchor || Math.abs(deltaTop) <= POSITION_EPSILON) return;
    activeAnchor.viewportOffset -= deltaTop;
    this.restartLayoutStabilization();
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

  private isUserScrolling(): boolean {
    return performance.now() - Math.max(this.lastWheelAt, this.lastTouchMoveAt) <= WHEEL_GESTURE_IDLE_MS;
  }
}
