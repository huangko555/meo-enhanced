import type { EditorView } from '@codemirror/view';

export interface ViewportDocumentAnchor {
  position: number;
  lineOffset: number;
  viewportOffset?: number;
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

export type ViewportAnchorOwner = 'editor' | 'preview';

export type ViewportAnchorToken = object & {
  readonly __viewportAnchorHandle: unique symbol;
};

export interface PreviewViewportSurface {
  captureTopVisiblePosition(): { line: number; lineOffset: number } | null;
  restoreTopVisiblePosition(
    position: { line: number; lineOffset: number },
    isCurrent: () => boolean
  ): void;
}

interface ViewportControllerOptions {
  attachInteractions?: boolean;
  getMode?: () => 'live' | 'source';
  previewSurface?: PreviewViewportSurface;
}

interface ScrollPosition {
  top: number;
  left: number;
}

interface ScrollTarget {
  top?: number;
  left?: number;
}

export interface ViewportHistorySnapshot {
  scrollTop: number;
  selection: {
    lineNumber: number;
    visibleFromLineNumber: number;
    visibleToLineNumber: number;
    wasVisible: boolean;
  };
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

type NavigationRevealPhase =
  | 'reserved'
  | 'measured'
  | 'adopted'
  | 'settling'
  | 'idle'
  | 'stale'
  | 'disposed';

type NavigationRevealMeasurement =
  | { readonly kind: 'target'; readonly target: ScrollTarget }
  | { readonly kind: 'stable' }
  | { readonly kind: 'unavailable' };

interface NavigationRevealState {
  ownerGeneration: number;
  phase: NavigationRevealPhase;
  readonly isCurrent: () => boolean;
}

interface NavigationRevealOptions {
  readonly schedule?: 'immediate' | 'next-frame';
  readonly settle?: boolean;
}

interface RevealPositionOptions {
  readonly y?: 'nearest' | 'center' | 'start';
  readonly yMargin?: number;
  readonly schedule?: 'immediate' | 'next-frame';
}

interface ActiveScrollTarget {
  changedSinceFrame: boolean;
  frameScheduled: boolean;
  generation: number;
  position: ScrollPosition;
  remainingFrames: number;
  stableFrames: number;
}

interface ViewportAnchorTokenRecord {
  anchor: ViewportDocumentAnchor;
  readonly interactionGeneration: number;
  readonly projectedOwners: Set<ViewportAnchorOwner>;
}

type ViewportAnchorSuppressionReason =
  | 'parent-suppressed'
  | 'null-token'
  | 'foreign-token'
  | 'stale-token'
  | 'duplicate-target'
  | 'unavailable-target';

type IdleAnchorTransactionScope = {
  readonly kind: 'idle';
};

type ActiveAnchorTransactionScope = {
  closed: boolean;
  conflicted: boolean;
  readonly parent: AnchorTransactionScope;
} & (
  | {
      readonly kind: 'current';
      readonly record: ViewportAnchorTokenRecord;
      readonly target: ViewportAnchorOwner;
      readonly anchor: ViewportDocumentAnchor;
      readonly previousDocumentText: string;
      documentChangeObserved: boolean;
    }
  | {
      readonly kind: 'suppressed';
      readonly reason: ViewportAnchorSuppressionReason;
    }
);

type AnchorTransactionScope = IdleAnchorTransactionScope | ActiveAnchorTransactionScope;

const IDLE_ANCHOR_TRANSACTION_SCOPE: IdleAnchorTransactionScope = Object.freeze({ kind: 'idle' });
const CONCURRENT_ANCHOR_TRANSACTION_ERROR =
  'Viewport anchor transactions must be awaited serially';

interface ChangedDocumentRange {
  readonly from: number;
  readonly previousTo: number;
  readonly insertedText: string;
}

function findChangedDocumentRange(previousText: string, nextText: string): ChangedDocumentRange | null {
  if (previousText === nextText) return null;

  let from = 0;
  const sharedLength = Math.min(previousText.length, nextText.length);
  while (from < sharedLength && previousText.charCodeAt(from) === nextText.charCodeAt(from)) {
    from += 1;
  }

  let previousTo = previousText.length;
  let nextTo = nextText.length;
  while (
    previousTo > from &&
    nextTo > from &&
    previousText.charCodeAt(previousTo - 1) === nextText.charCodeAt(nextTo - 1)
  ) {
    previousTo -= 1;
    nextTo -= 1;
  }
  return { from, previousTo, insertedText: nextText.slice(from, nextTo) };
}

function mapPositionThroughDocumentChange(
  position: number,
  previousText: string,
  nextText: string,
  change: ChangedDocumentRange
): number {
  const mapThroughReplacement = (): number => {
    const delta = change.insertedText.length - (change.previousTo - change.from);
    if (position <= change.from) return position;
    if (position >= change.previousTo) return position + delta;
    return change.from + change.insertedText.length;
  };
  if (position <= change.from || position >= change.previousTo) return mapThroughReplacement();

  const contextRadius = 80;
  const contextFrom = Math.max(change.from, position - contextRadius);
  const contextTo = Math.min(change.previousTo, position + contextRadius);
  const context = previousText.slice(contextFrom, contextTo);
  if (context.length >= 16) {
    const contextIndex = nextText.indexOf(context);
    if (contextIndex >= 0 && nextText.indexOf(context, contextIndex + 1) < 0) {
      return contextIndex + (position - contextFrom);
    }
  }

  const lineFrom = previousText.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const lineBreak = previousText.indexOf('\n', position);
  const lineTo = lineBreak < 0 ? previousText.length : lineBreak;
  const lineText = previousText.slice(lineFrom, lineTo);
  if (lineText.trim()) {
    const expected = mapThroughReplacement();
    let bestLineFrom = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let searchFrom = 0;
    while (searchFrom <= nextText.length) {
      const match = nextText.indexOf(lineText, searchFrom);
      if (match < 0) break;
      const distance = Math.abs(match - expected);
      if (distance < bestDistance) {
        bestLineFrom = match;
        bestDistance = distance;
      }
      searchFrom = match + Math.max(1, lineText.length);
    }
    if (bestLineFrom >= 0) {
      return bestLineFrom + Math.min(position - lineFrom, lineText.length);
    }
  }

  const replacedLength = change.previousTo - change.from;
  if (replacedLength > 0 && change.insertedText.length > 0) {
    const relativeOffset = (position - change.from) / replacedLength;
    return change.from + Math.round(relativeOffset * change.insertedText.length);
  }
  return mapThroughReplacement();
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
  private navigationGeneration = 0;
  private pendingNavigationTarget: { position: number; generation: number } | null = null;
  private scrollLockGeneration = 0;
  private activeScrollTarget: ActiveScrollTarget | null = null;
  private activeLayoutAnchor: ActiveLayoutAnchor | null = null;
  private anchorStabilizationGeneration: number | null = null;
  private lastTouchY: number | null = null;
  private scrollbarDragActive = false;
  private pendingHistoryShortcutViewport: ViewportHistorySnapshot | null = null;
  private readonly getMode: () => 'live' | 'source';
  private readonly previewSurface: PreviewViewportSurface | null;
  private readonly anchorTokens = new WeakMap<ViewportAnchorToken, ViewportAnchorTokenRecord>();
  private anchorTransactionScope: AnchorTransactionScope = IDLE_ANCHOR_TRANSACTION_SCOPE;
  private anchorMutationDepth = 0;
  private documentChangeDepth = 0;
  private pendingAsyncAnchorTransactions = 0;
  private readonly onWheel = (event: WheelEvent) => this.handleWheel(event);
  private readonly onScroll = () => this.scheduleActiveScrollFrame();
  private readonly onPointerDown = (event: PointerEvent) => this.handlePotentialLayoutInteraction(event);
  private readonly onPointerUp = () => this.finishScrollbarDrag();
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
  private readonly onKeyUp = (event: KeyboardEvent) => this.handleKeyUp(event);
  private readonly onBeforeInput = () => { this.navigationGeneration += 1; };
  private readonly onTouchStart = (event: TouchEvent) => this.handleTouchStart(event);
  private readonly onTouchMove = (event: TouchEvent) => this.handleTouchMove(event);
  private readonly onTouchEnd = () => this.finishTouchGesture();

  constructor(
    private readonly view: EditorView,
    options: ViewportControllerOptions = {}
  ) {
    this.getMode = options.getMode ?? (() => 'live');
    this.previewSurface = options.previewSurface ?? null;
    controllerByDom.set(view.dom, this);
    if (options.attachInteractions !== false) {
      view.scrollDOM.addEventListener('wheel', this.onWheel, { passive: true });
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      view.scrollDOM.addEventListener('touchstart', this.onTouchStart, { passive: true });
      view.scrollDOM.addEventListener('touchmove', this.onTouchMove, { passive: true });
      view.scrollDOM.addEventListener('touchend', this.onTouchEnd, { passive: true });
      view.scrollDOM.addEventListener('touchcancel', this.onTouchEnd, { passive: true });
      view.scrollDOM.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: true });
      view.scrollDOM.ownerDocument.addEventListener('pointerup', this.onPointerUp, true);
      view.scrollDOM.ownerDocument.addEventListener('pointercancel', this.onPointerUp, true);
      view.dom.addEventListener('keydown', this.onKeyDown, true);
      view.dom.addEventListener('keyup', this.onKeyUp, true);
      view.dom.addEventListener('beforeinput', this.onBeforeInput, true);
      this.interactionsAttached = true;
    }
  }

  markInteraction(): void {
    const scope = this.anchorTransactionScope;
    const programmaticCurrentTransaction = scope.kind === 'current'
      && this.isAnchorTokenCurrent(scope.record)
      && (this.anchorMutationDepth > 0 || this.documentChangeDepth > 0);
    if (!programmaticCurrentTransaction) {
      this.interactionGeneration += 1;
    }
    this.navigationGeneration += 1;
    this.pendingNavigationTarget = null;
    this.scrollLockGeneration += 1;
    this.generation += 1;
    this.activeScrollTarget = null;
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = null;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.lastTouchY = null;
  }

  private markNavigationScrollStart(): void {
    const scope = this.anchorTransactionScope;
    const programmaticCurrentTransaction = scope.kind === 'current'
      && this.isAnchorTokenCurrent(scope.record)
      && (this.anchorMutationDepth > 0 || this.documentChangeDepth > 0);
    if (!programmaticCurrentTransaction) {
      this.interactionGeneration += 1;
    }
    this.scrollLockGeneration += 1;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.lastTouchY = null;
  }

  preserveLayoutChange(region: ViewportLayoutRegion, mutate: () => void): void {
    if (this.destroyed || !region.element.isConnected) {
      mutate();
      return;
    }
    if (this.scrollbarDragActive) {
      mutate();
      this.view.requestMeasure();
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
  reconcileAfterEditorUpdate(mapPosition?: (position: number) => number): void {
    const activeAnchor = this.activeLayoutAnchor;
    if (activeAnchor) {
      if (mapPosition) activeAnchor.position = mapPosition(activeAnchor.position);
      this.restartLayoutStabilization();
    }
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

  lockScrollTop(targetTop: number, isCurrent: () => boolean = () => true): void {
    // Live decorations can finish measuring several frames after a history
    // transaction. Hold the absolute viewport until that layout has settled;
    // markInteraction cancels the lock as soon as the user acts again.
    if (this.destroyed || !isCurrent()) return;
    this.markInteraction();
    const lockGeneration = ++this.scrollLockGeneration;
    let remainingFrames = MAX_SETTLE_FRAMES;
    const write = () => {
      if (
        this.destroyed ||
        lockGeneration !== this.scrollLockGeneration ||
        !isCurrent()
      ) return;
      this.view.scrollDOM.scrollTop = Math.max(0, Math.min(
        targetTop,
        this.view.scrollDOM.scrollHeight - this.view.scrollDOM.clientHeight
      ));
      remainingFrames -= 1;
      if (remainingFrames > 0 && isCurrent()) requestAnimationFrame(write);
    };
    write();
  }

  consumeHistoryShortcutViewport(): ViewportHistorySnapshot | null {
    const viewport = this.pendingHistoryShortcutViewport;
    this.pendingHistoryShortcutViewport = null;
    return viewport;
  }

  captureHistorySnapshot(): ViewportHistorySnapshot {
    return this.consumeHistoryShortcutViewport() ?? this.captureHistoryShortcutViewport();
  }

  captureCurrentHistorySnapshot(): ViewportHistorySnapshot {
    return this.captureHistoryShortcutViewport();
  }

  captureDocumentAnchor(): ViewportDocumentAnchor {
    const scrollTop = Math.max(0, this.view.scrollDOM.scrollTop);
    const canInspectLayout = typeof this.view.scrollDOM.getBoundingClientRect === 'function'
      && typeof this.view.contentDOM?.querySelectorAll === 'function';
    if (canInspectLayout) {
      const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
      const renderedBlock = Array.from(
        this.view.contentDOM.querySelectorAll<HTMLElement>('[data-meo-rendered-block-start-line]')
      ).find((block) => {
        const rect = block.getBoundingClientRect();
        return rect.top <= scrollerRect.top && rect.bottom > scrollerRect.top;
      });
      const renderedBlockStartLine = Number(renderedBlock?.dataset.meoRenderedBlockStartLine);
      if (
        renderedBlock &&
        Number.isInteger(renderedBlockStartLine) &&
        renderedBlockStartLine > 0 &&
        renderedBlockStartLine <= this.view.state.doc.lines
      ) {
        const rect = renderedBlock.getBoundingClientRect();
        return {
          position: this.view.state.doc.line(renderedBlockStartLine).from,
          lineOffset: Math.max(0, scrollerRect.top - rect.top)
        };
      }
    }
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
    const viewportOffset = Number.isFinite(anchor.viewportOffset)
      ? Math.max(0, anchor.viewportOffset ?? 0)
      : null;
    this.stabilize(() => {
      if (viewportOffset !== null) {
        const coords = this.view.coordsAtPos(position);
        if (coords) {
          const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
          return {
            top: Math.max(
              0,
              this.view.scrollDOM.scrollTop + coords.top - scrollerRect.top - viewportOffset
            )
          };
        }
      }
      return { top: Math.max(0, this.view.lineBlockAt(position).top + lineOffset) };
    }, { onSettled });
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

  preservePositionWhileMutation(
    position: number,
    mutate: () => void,
    schedule: StabilizeOptions['schedule'] = 'next-frame'
  ): void {
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
      schedule
    });
  }

  /** Reveals through the owned scroller; pending geometry never displaces the current viewport owner. */
  revealElement(element: HTMLElement, isCurrent: () => boolean = () => true): void {
    this.runNavigationReveal(() => {
      if (!element.isConnected) return { kind: 'unavailable' };
      const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const nearestEdge = (startDelta: number, endDelta: number): 'start' | 'end' | null => {
        if (startDelta >= 0 && endDelta <= 0) return null;
        if (startDelta < 0 && endDelta > 0) {
          return Math.abs(startDelta) <= endDelta ? 'start' : 'end';
        }
        return startDelta < 0 ? 'start' : 'end';
      };
      const verticalEdge = nearestEdge(
        elementRect.top - scrollerRect.top,
        elementRect.bottom - scrollerRect.bottom
      );
      const horizontalEdge = nearestEdge(
        elementRect.left - scrollerRect.left,
        elementRect.right - scrollerRect.right
      );
      if (!verticalEdge && !horizontalEdge) return { kind: 'stable' };
      return {
        kind: 'target',
        target: {
          ...(verticalEdge ? {
            top: this.view.scrollDOM.scrollTop + (
              verticalEdge === 'start'
                ? elementRect.top - scrollerRect.top
                : elementRect.bottom - scrollerRect.bottom
            )
          } : {}),
          ...(horizontalEdge ? {
            left: this.view.scrollDOM.scrollLeft + (
              horizontalEdge === 'start'
                ? elementRect.left - scrollerRect.left
                : elementRect.right - scrollerRect.right
            )
          } : {})
        }
      };
    }, { settle: true }, isCurrent);
  }

  destroy(): void {
    this.destroyed = true;
    this.interactionGeneration += 1;
    this.navigationGeneration += 1;
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
      this.view.scrollDOM.removeEventListener('pointerdown', this.onPointerDown, true);
      this.view.scrollDOM.ownerDocument.removeEventListener('pointerup', this.onPointerUp, true);
      this.view.scrollDOM.ownerDocument.removeEventListener('pointercancel', this.onPointerUp, true);
      this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
      this.view.dom.removeEventListener('keyup', this.onKeyUp, true);
      this.view.dom.removeEventListener('beforeinput', this.onBeforeInput, true);
      this.interactionsAttached = false;
    }
  }

  private stabilize(readTarget: () => ScrollTarget | null, options: StabilizeOptions = {}): void {
    if (this.destroyed) return;
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
      if (
        this.destroyed || generation !== this.generation ||
        attempts >= MAX_SETTLE_FRAMES
      ) {
        finish();
        return;
      }
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
          if (this.destroyed || generation !== this.generation) {
            finish();
            return;
          }
          if (!target) {
            finish();
            return;
          }
          queueMicrotask(() => {
            if (this.destroyed || generation !== this.generation) {
              finish();
              return;
            }
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

  /** Schedule/read are reservations; only a current non-zero write atomically adopts viewport ownership. */
  private runNavigationReveal(
    readMeasurement: () => NavigationRevealMeasurement,
    options: NavigationRevealOptions,
    isCurrent: () => boolean
  ): void {
    if (this.destroyed || !isCurrent()) return;
    const state: NavigationRevealState = {
      ownerGeneration: this.generation,
      phase: 'reserved',
      isCurrent
    };
    let attempts = 0;
    let stableFrames = 0;
    const isRevealCurrent = (): boolean => (
      !this.destroyed &&
      state.ownerGeneration === this.generation &&
      state.isCurrent()
    );
    const finish = (): void => {
      state.phase = this.destroyed
        ? 'disposed'
        : isRevealCurrent()
          ? 'idle'
          : 'stale';
    };
    const scheduleNextMeasure = (measure: () => void): void => {
      if (!isRevealCurrent()) {
        finish();
        return;
      }
      requestAnimationFrame(() => {
        if (isRevealCurrent()) measure();
        else finish();
      });
    };
    const completeFrame = (measure: () => void, changed: boolean): void => {
      stableFrames = changed ? 0 : stableFrames + 1;
      if (
        !options.settle ||
        stableFrames >= REQUIRED_STABLE_FRAMES ||
        attempts >= MAX_SETTLE_FRAMES
      ) {
        finish();
        return;
      }
      state.phase = 'settling';
      scheduleNextMeasure(measure);
    };
    const measure = (): void => {
      if (!isRevealCurrent() || attempts >= MAX_SETTLE_FRAMES) {
        finish();
        return;
      }
      attempts += 1;
      this.view.requestMeasure({
        read: () => {
          if (!isRevealCurrent()) return { kind: 'unavailable' } as const;
          if (state.phase === 'reserved') state.phase = 'measured';
          try {
            const measurement = readMeasurement();
            if (measurement.kind !== 'target') return measurement;
            return {
              kind: 'target',
              target: this.resolveScrollTarget(measurement.target, this.readScrollPosition())
            } as const;
          } catch {
            return { kind: 'unavailable' } as const;
          }
        },
        write: (measurement) => {
          if (!isRevealCurrent()) {
            finish();
            return;
          }
          if (measurement.kind === 'unavailable') {
            finish();
            return;
          }
          if (measurement.kind === 'stable') {
            if (state.phase === 'measured') finish();
            else completeFrame(measure, false);
            return;
          }

          const current = this.readScrollPosition();
          const target = this.resolveScrollTarget(measurement.target, current);
          const differs = (
            Math.abs(target.top - current.top) > POSITION_EPSILON ||
            Math.abs(target.left - current.left) > POSITION_EPSILON
          );
          if (!differs) {
            if (state.phase === 'measured') finish();
            else completeFrame(measure, false);
            return;
          }

          if (state.phase === 'measured') {
            if (!isRevealCurrent()) {
              finish();
              return;
            }
            this.markNavigationScrollStart();
            state.ownerGeneration = ++this.generation;
            this.activeScrollTarget = null;
            this.activeLayoutAnchor = null;
            this.anchorStabilizationGeneration = null;
            state.phase = 'adopted';
          }
          if (!isRevealCurrent()) {
            finish();
            return;
          }
          const changed = this.writeScrollPosition(target);
          state.phase = 'settling';
          completeFrame(measure, changed);
        }
      });
    };

    if (options.schedule === 'next-frame') scheduleNextMeasure(measure);
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
    this.interactionGeneration += 1;
    this.navigationGeneration += 1;
    this.generation += 1;
    this.scrollLockGeneration += 1;
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

  private handleKeyDown(event: KeyboardEvent): void {
    const isModifierKey = event.key === 'Control' || event.key === 'Meta';
    const isHistoryShortcut = (
      (event.ctrlKey || event.metaKey) &&
      (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')
    );
    if (isModifierKey) {
      this.pendingHistoryShortcutViewport = this.captureHistoryShortcutViewport();
    } else if (isHistoryShortcut) {
      this.pendingHistoryShortcutViewport ??= this.captureHistoryShortcutViewport();
    } else {
      this.pendingHistoryShortcutViewport = null;
    }
    this.markInteraction();
    if (!this.canChangeLiveLayout(event)) return;
    this.startInteractionLayoutStabilization(
      this.getInteractionLayoutRange(event.target, this.view.state.selection.main.head)
    );
  }

  private handlePotentialLayoutInteraction(event: PointerEvent): void {
    this.markInteraction();
    if (event.button === 0 && event.target === this.view.scrollDOM) {
      this.scrollbarDragActive = true;
      return;
    }
    if (this.getMode() !== 'live' || event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        '.meo-mermaid-editing-block, .meo-latex-math-editing-block, .meo-mermaid-toolbar, .meo-latex-math-toolbar, .meo-md-html-block, .meo-md-html-source-control, .meo-md-code-block-start, .meo-md-code-block-end'
      )
    ) return;
    const pointerPosition = this.view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
      this.view.posAtCoords({ x: this.view.contentDOM.getBoundingClientRect().left + 1, y: event.clientY });
    this.startInteractionLayoutStabilization(
      this.getInteractionLayoutRange(event.target, pointerPosition ?? this.view.state.selection.main.head)
    );
  }

  private canChangeLiveLayout(event: KeyboardEvent): boolean {
    if (this.getMode() !== 'live') return false;
    if (event.isComposing || event.key.length === 1) return true;
    if (event.ctrlKey || event.metaKey) {
      return ['v', 'x', 'z', 'y'].includes(event.key.toLowerCase());
    }
    return event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter' || event.key === 'Tab';
  }

  private startInteractionLayoutStabilization(changedRange: { from: number; to: number }): void {
    const anchor = this.captureInteractionLayoutAnchor(changedRange);
    if (!anchor) return;
    this.activeLayoutAnchor = {
      ...anchor,
      frameScheduled: false,
      remainingFrames: MAX_SETTLE_FRAMES,
      revision: 0,
      stableFrames: 0
    };
    this.restartLayoutStabilization();
  }

  private getInteractionLayoutRange(target: EventTarget | null, fallbackPosition: number): { from: number; to: number } {
    const renderedBlock = target instanceof Element
      ? target.closest<HTMLElement>(
          '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
        )
      : null;
    const startLine = Number(renderedBlock?.dataset.meoRenderedBlockStartLine);
    const endLine = Number(renderedBlock?.dataset.meoRenderedBlockEndLine);
    if (
      Number.isInteger(startLine) && Number.isInteger(endLine) &&
      startLine >= 1 && endLine >= startLine && endLine <= this.view.state.doc.lines
    ) {
      return {
        from: this.view.state.doc.line(startLine).from,
        to: this.view.state.doc.line(endLine).to
      };
    }
    const line = this.view.state.doc.lineAt(Math.max(0, Math.min(fallbackPosition, this.view.state.doc.length)));
    return { from: line.from, to: line.to };
  }

  private handleTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    if (this.getMode() !== 'live' || !touch) {
      this.markInteraction();
      return;
    }
    this.interactionGeneration += 1;
    this.navigationGeneration += 1;
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
    this.interactionGeneration += 1;
    this.navigationGeneration += 1;
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

  /** Reserves currentness for one navigation intent without disturbing the active viewport owner. */
  beginNavigationReveal(): () => boolean {
    const navigationGeneration = ++this.navigationGeneration;
    this.pendingNavigationTarget = null;
    return () => !this.destroyed && navigationGeneration === this.navigationGeneration;
  }

  /** Reveals a document position; viewport ownership changes only when measurement requires a scroll. */
  revealPosition(
    position: number,
    options: RevealPositionOptions = {},
    isCurrent: () => boolean = () => true
  ): void {
    this.revealPositionInternal(position, options, isCurrent, false);
  }

  /** Reveals a document position through the finite layout-settlement window. */
  revealPositionUntilStable(
    position: number,
    options: RevealPositionOptions = {},
    isCurrent: () => boolean = () => true
  ): void {
    this.revealPositionInternal(position, options, isCurrent, true);
  }

  private revealPositionInternal(
    position: number,
    {
      y = 'nearest',
      yMargin = 0,
      schedule = 'immediate'
    }: RevealPositionOptions = {},
    isCurrent: () => boolean,
    settle: boolean
  ): void {
    const targetPosition = Math.max(0, Math.min(position, this.view.state.doc.length));
    if (isCurrent()) {
      this.pendingNavigationTarget = {
        position: targetPosition,
        generation: this.navigationGeneration
      };
    }
    this.runNavigationReveal(() => {
      const current = this.readScrollPosition();
      const coords = this.view.coordsAtPos(targetPosition);
      const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
      if (y === 'center') {
        if (coords) {
          return {
            kind: 'target',
            target: {
              top: current.top + (coords.top + coords.bottom - scrollerRect.top - scrollerRect.bottom) / 2
            }
          };
        }
        const block = this.view.lineBlockAt(targetPosition);
        return {
          kind: 'target',
          target: {
            top: block.top - Math.max(0, (this.view.scrollDOM.clientHeight - block.height) / 2)
          }
        };
      }
      if (y === 'start') {
        const block = this.view.lineBlockAt(targetPosition);
        return {
          kind: 'target',
          target: { top: block.top - Math.max(0, yMargin) }
        };
      }
      if (coords) {
        if (coords.top >= scrollerRect.top && coords.bottom <= scrollerRect.bottom) {
          return { kind: 'stable' };
        }
        return {
          kind: 'target',
          target: {
            top: current.top + (
              coords.top < scrollerRect.top
                ? coords.top - scrollerRect.top
                : coords.bottom - scrollerRect.bottom
            )
          }
        };
      }
      const block = this.view.lineBlockAt(targetPosition);
      const viewportHeight = this.view.scrollDOM.clientHeight;
      if (block.top < current.top) return { kind: 'target', target: { top: block.top } };
      if (block.bottom > current.top + viewportHeight) {
        return { kind: 'target', target: { top: block.bottom - viewportHeight } };
      }
      return { kind: 'stable' };
    }, { schedule, settle }, isCurrent);
  }

  captureAnchorToken(owner: ViewportAnchorOwner): ViewportAnchorToken | null {
    if (this.destroyed) return null;
    const navigationAnchor = owner === 'editor'
      ? this.consumeVisibleNavigationTargetAnchor()
      : null;
    this.markInteraction();
    const anchor = owner === 'editor'
      ? navigationAnchor ?? this.captureDocumentAnchor()
      : this.capturePreviewDocumentAnchor();
    if (!anchor) return null;
    const handle = Object.freeze({}) as ViewportAnchorToken;
    this.anchorTokens.set(handle, {
      anchor,
      interactionGeneration: this.interactionGeneration,
      projectedOwners: new Set()
    });
    return handle;
  }

  restoreAnchorToken(handle: ViewportAnchorToken, owner: ViewportAnchorOwner): void {
    this.runAnchorTransaction(handle, owner, () => undefined);
  }

  /**
   * Runs one serialized surface transaction and then projects its Controller-bound token.
   * Every outer call establishes a scope: invalid targets are suppressed while their mutation
   * still runs, and awaited Document changes remain in that scope until settlement. Synchronous
   * nesting is allowed; after a mutation yields, only a newly-current successor may nest, while
   * every invalid or already-used competing transaction throws before mutation. Real interactions
   * outside the active mutation invalidate every delayed projection.
   */
  runAnchorTransaction(
    handle: ViewportAnchorToken | null,
    owner: ViewportAnchorOwner,
    mutate: (isCurrent: () => boolean) => void | Promise<void>
  ): void | Promise<void> {
    const parent = this.anchorTransactionScope;
    const record = handle ? this.anchorTokens.get(handle) : undefined;
    const targetAvailable = owner === 'editor' || this.previewSurface !== null;
    const currentTarget = Boolean(
      record &&
      targetAvailable &&
      this.isAnchorTokenCurrent(record) &&
      !record.projectedOwners.has(owner)
    );
    if (
      this.pendingAsyncAnchorTransactions > 0 &&
      this.anchorMutationDepth === 0 &&
      !currentTarget
    ) {
      throw new Error(CONCURRENT_ANCHOR_TRANSACTION_ERROR);
    }
    let scope: ActiveAnchorTransactionScope;
    if (parent.kind === 'suppressed') {
      scope = {
        kind: 'suppressed',
        reason: 'parent-suppressed',
        parent,
        closed: false,
        conflicted: false
      };
    } else if (record && currentTarget) {
      scope = {
        kind: 'current',
        record,
        target: owner,
        anchor: { ...record.anchor },
        previousDocumentText: this.view.state.doc.toString(),
        documentChangeObserved: false,
        parent,
        closed: false,
        conflicted: false
      };
    } else {
      const reason: ViewportAnchorSuppressionReason = !handle
        ? 'null-token'
        : !record
          ? 'foreign-token'
          : !targetAvailable
            ? 'unavailable-target'
            : record.projectedOwners.has(owner)
              ? 'duplicate-target'
              : 'stale-token';
      scope = { kind: 'suppressed', reason, parent, closed: false, conflicted: false };
    }
    this.anchorTransactionScope = scope;
    const isCurrent = () => this.isAnchorTransactionScopeCurrent(scope);
    let result: void | Promise<void>;
    this.anchorMutationDepth += 1;
    try {
      result = mutate(isCurrent);
    } catch (error) {
      this.closeAnchorTransactionScope(scope);
      throw error;
    } finally {
      this.anchorMutationDepth -= 1;
    }
    if (result && typeof result.then === 'function') {
      this.pendingAsyncAnchorTransactions += 1;
      return Promise.resolve(result).then(
        () => this.completeAnchorTransactionScope(scope, true),
        (error: unknown) => {
          this.completeAnchorTransactionScope(scope, false);
          throw error;
        }
      ).finally(() => {
        this.pendingAsyncAnchorTransactions -= 1;
      });
    }
    this.completeAnchorTransactionScope(scope, true);
  }

  /** Uses the active scope, or captures the Editor surface for a standalone Document change. */
  runDocumentChange(mutate: () => void): void {
    if (this.anchorTransactionScope.kind !== 'idle') {
      if (this.anchorTransactionScope.kind === 'current') {
        this.anchorTransactionScope.documentChangeObserved = true;
      }
      this.documentChangeDepth += 1;
      try {
        mutate();
      } finally {
        this.documentChangeDepth -= 1;
      }
      return;
    }
    const handle = this.captureAnchorToken('editor');
    this.runAnchorTransaction(handle, 'editor', () => this.runDocumentChange(mutate));
  }

  private isAnchorTransactionScopeCurrent(scope: ActiveAnchorTransactionScope): boolean {
    return scope.kind === 'current'
      && !scope.closed
      && !scope.conflicted
      && this.isAnchorTokenCurrent(scope.record);
  }

  private completeAnchorTransactionScope(
    scope: ActiveAnchorTransactionScope,
    project: boolean
  ): void {
    this.ensureAnchorTransactionScopeCanComplete(scope);
    try {
      if (project) this.projectAnchorTransactionScope(scope);
    } finally {
      this.closeAnchorTransactionScope(scope);
    }
  }

  private ensureAnchorTransactionScopeCanComplete(scope: ActiveAnchorTransactionScope): void {
    if (this.anchorTransactionScope !== scope) {
      this.invalidateConflictingAnchorTransactionScopes(scope);
      this.closeAnchorTransactionScope(scope);
      throw new Error(CONCURRENT_ANCHOR_TRANSACTION_ERROR);
    }
  }

  private projectAnchorTransactionScope(scope: ActiveAnchorTransactionScope): void {
    if (!this.isAnchorTransactionScopeCurrent(scope) || scope.kind !== 'current') return;
    if (scope.documentChangeObserved) {
      // A presentation can synchronously invalidate rendered-block geometry. Commit the concrete
      // Editor layout before projecting the semantic entry anchor, including equal-text refreshes.
      this.captureDocumentAnchor();
    }
    const anchor = this.mapAnchorThroughDocumentChange(
      scope.anchor,
      scope.previousDocumentText,
      this.view.state.doc.toString()
    );
    if (!anchor) return;
    this.projectAnchorRecord(scope.record, scope.target, anchor);
    scope.record.anchor = anchor;
  }

  private invalidateConflictingAnchorTransactionScopes(scope: ActiveAnchorTransactionScope): void {
    scope.conflicted = true;
    let current = this.anchorTransactionScope;
    while (current.kind !== 'idle') {
      current.conflicted = true;
      current = current.parent;
    }
    this.interactionGeneration += 1;
  }

  private closeAnchorTransactionScope(scope: ActiveAnchorTransactionScope): void {
    scope.closed = true;
    if (this.anchorTransactionScope !== scope) return;
    let parent = scope.parent;
    while (parent.kind !== 'idle' && parent.closed) parent = parent.parent;
    this.anchorTransactionScope = parent;
  }

  private projectAnchorRecord(
    record: ViewportAnchorTokenRecord,
    owner: ViewportAnchorOwner,
    anchor: ViewportDocumentAnchor
  ): void {
    if (record.projectedOwners.has(owner)) return;
    if (owner === 'editor') {
      this.restoreDocumentAnchor(anchor, undefined, { force: true });
      record.projectedOwners.add(owner);
      return;
    }
    const line = this.view.state.doc.lineAt(
      Math.min(Math.max(0, anchor.position), this.view.state.doc.length)
    );
    this.previewSurface?.restoreTopVisiblePosition({
      line: line.number,
      lineOffset: anchor.lineOffset
    }, () => this.isAnchorTokenCurrent(record));
    record.projectedOwners.add(owner);
  }

  private mapAnchorThroughDocumentChange(
    anchor: ViewportDocumentAnchor,
    previousText: string,
    nextText: string
  ): ViewportDocumentAnchor | null {
    try {
      const change = findChangedDocumentRange(previousText, nextText);
      if (!change) return anchor;
      return {
        ...anchor,
        position: Math.min(
          Math.max(0, mapPositionThroughDocumentChange(anchor.position, previousText, nextText, change)),
          nextText.length
        )
      };
    } catch {
      return null;
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Control' || event.key === 'Meta') {
      this.pendingHistoryShortcutViewport = null;
    }
  }

  private captureHistoryShortcutViewport(): ViewportHistorySnapshot {
    const head = this.view.state.selection.main.head;
    const coords = this.view.coordsAtPos(head);
    const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
    const topBlock = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop);
    const bottomBlock = this.view.lineBlockAtHeight(
      this.view.scrollDOM.scrollTop + this.view.scrollDOM.clientHeight
    );
    return {
      scrollTop: this.view.scrollDOM.scrollTop,
      selection: {
        lineNumber: this.view.state.doc.lineAt(head).number,
        visibleFromLineNumber: this.view.state.doc.lineAt(topBlock.from).number,
        visibleToLineNumber: this.view.state.doc.lineAt(bottomBlock.to).number,
        wasVisible: Boolean(
          (
            coords &&
            coords.bottom > scrollerRect.top &&
            coords.top < scrollerRect.bottom
          ) || (
            head >= this.view.viewport.from &&
            head <= this.view.viewport.to
          )
        )
      }
    };
  }

  private finishScrollbarDrag(): void {
    if (!this.scrollbarDragActive) return;
    this.scrollbarDragActive = false;
    this.markInteraction();
  }

  private capturePreviewDocumentAnchor(): ViewportDocumentAnchor | null {
    const position = this.previewSurface?.captureTopVisiblePosition();
    if (!position) return null;
    const lineNumber = Math.min(
      Math.max(1, Math.floor(Number.isFinite(position.line) ? position.line : 1)),
      this.view.state.doc.lines
    );
    return {
      position: this.view.state.doc.line(lineNumber).from,
      lineOffset: Number.isFinite(position.lineOffset) ? Math.max(0, position.lineOffset) : 0
    };
  }

  private consumeVisibleNavigationTargetAnchor(): ViewportDocumentAnchor | null {
    const target = this.pendingNavigationTarget;
    this.pendingNavigationTarget = null;
    if (!target || target.generation !== this.navigationGeneration) return null;
    const { position } = target;
    const coords = this.view.coordsAtPos(position);
    const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
    if (!coords || coords.bottom <= scrollerRect.top || coords.top >= scrollerRect.bottom) return null;
    return {
      position,
      lineOffset: 0,
      viewportOffset: Math.max(0, coords.top - scrollerRect.top)
    };
  }

  private isAnchorTokenCurrent(record: ViewportAnchorTokenRecord): boolean {
    return !this.destroyed && record.interactionGeneration === this.interactionGeneration;
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
      viewportOffset: this.view.lineBlockAt(anchor.position).top - this.view.scrollDOM.scrollTop
    } : null;
  }

  private captureInteractionLayoutAnchor(changedRange: { from: number; to: number }): LayoutAnchor | null {
    const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
    const candidates = Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
      .map((line) => ({
        position: this.view.posAtDOM(line),
        top: line.getBoundingClientRect().top
      }))
      .filter((candidate) => (
        (candidate.position < changedRange.from || candidate.position > changedRange.to) &&
        candidate.top >= scrollerRect.top && candidate.top < scrollerRect.bottom
      ));
    if (candidates.length === 0) return null;

    const readingY = scrollerRect.top + scrollerRect.height * 0.25;
    const anchor = candidates.reduce((closest, candidate) => (
      Math.abs(candidate.top - readingY) < Math.abs(closest.top - readingY) ? candidate : closest
    ));
    return {
      position: anchor.position,
      viewportOffset: this.view.lineBlockAt(anchor.position).top - this.view.scrollDOM.scrollTop
    };
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
    return this.scrollbarDragActive ||
      performance.now() - Math.max(this.lastWheelAt, this.lastTouchMoveAt) <= WHEEL_GESTURE_IDLE_MS;
  }
}
