import { readDocumentTextProjection } from '../application/documentTextProjection';
import { editorScrollIntoView } from '../editor/scrollEffects';
import { editorViewportBounds } from '../editor/editorViewportBounds';
import { tableRowWindowFor } from '../editor/tableRowWindow';
import { sourceLinePositionAtTarget } from '../editor/domSourceLine';
import { NativeInputViewport } from '../editor/nativeInputViewport';
import { EditorView } from '@codemirror/view';
import { createLinkedViewportMap, type LinkedViewportMap, type LinkedViewportPoint } from './linkedViewportMap';

export interface ViewportDocumentAnchor {
  position: number;
  lineOffset: number;
  /** Preview captures may need a different offset when projected into Editor. */
  editorLineOffset?: number;
  viewportOffset?: number;
  renderedBlock?: boolean;
  /** The position identifies a measured visual text row, not a block boundary. */
  preciseTextPosition?: true;
  /** Continuous semantic position inside a rendered source range. */
  sourceRange?: {
    startLine: number;
    endLine: number;
    progress: number;
  };
}

type RestoreDocumentAnchorOptions = {
  force?: boolean;
  requiredStableFrames?: number;
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
export type LinkedPreviewActivationOwner = ViewportAnchorOwner | 'last-interaction';

export interface PreviewDocumentChange {
  readonly previousText: string;
  readonly nextText: string;
}

export type ViewportAnchorToken = object & {
  readonly __viewportAnchorHandle: unique symbol;
};

/** Converts visual-line context into a bounded viewport margin at reveal time. */
export function visualLineContextMargin(
  view: Pick<EditorView, 'defaultLineHeight' | 'scrollDOM'>,
  lineCount: number
): number {
  const requested = Math.max(0, view.defaultLineHeight * lineCount);
  return Math.min(requested, view.scrollDOM.clientHeight * 0.2);
}

export interface PreviewViewportSurface {
  /** A mounted unchanged glyph is more precise than an estimated source range. */
  captureVisualReadingAnchor?(viewportRatio?: number): (() => boolean) | null;
  captureTopVisiblePosition(viewportOffset?: number): {
    line: number;
    lineOffset: number;
    editorLineOffset?: number;
    viewportOffset?: number;
    interpolatedWhitespace?: boolean;
    sourceRange?: { startLine: number; endLine: number; progress: number };
  } | null;
  captureReadingPosition?(viewportRatio: number): {
    line: number;
    lineOffset: number;
    editorLineOffset?: number;
    viewportOffset?: number;
    interpolatedWhitespace?: boolean;
    sourceRange?: { startLine: number; endLine: number; progress: number };
  } | null;
  restoreTopVisiblePosition(
    position: {
      line: number;
      lineOffset: number;
      viewportOffset?: number;
      sourceRange?: { startLine: number; endLine: number; progress: number };
    },
    isCurrent: () => boolean
  ): void;
  captureLinkedGeometry?(): {
    readonly regions: readonly {
      readonly startLine: number;
      readonly endLine: number;
      readonly top: number;
      readonly bottom: number;
    }[];
    readonly maximumScrollTop: number;
  } | null;
  readScrollTop?(): number;
  writeScrollTop?(scrollTop: number): void;
  /** An estimated gap has geometry, but cannot paint an explicit alignment. */
  isSourceLineRendered?(line: number): boolean;
  /** Native gestures own their scroll position until pointer/momentum settles. */
  isInteracting?(): boolean;
  /** Only the native thumb forbids viewport writes; wheel reflow keeps its witness. */
  isScrollbarDragging?(): boolean;
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
    viewportOffset?: number;
  };
}

interface LayoutAnchor {
  position: number;
  viewportOffset: number;
  /** Input/pointer retention follows painted DOM, independent of height-map estimates. */
  visualViewportOffset?: number;
  readingDocumentTop?: number;
  readingScrollTop?: number;
  readingHeightMapTop?: number;
  readingNativeAdopted?: boolean;
}

interface ActiveLayoutAnchor extends LayoutAnchor {
  frameScheduled: boolean;
  remainingFrames: number;
  revision: number;
  stableFrames: number;
}

interface StabilizeOptions {
  canSettle?: () => boolean;
  requiredStableFrames?: number;
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
  readonly geometry?: 'caret' | 'line-block';
  readonly marginMode?: 'outside-only' | 'comfort-band';
  /** Evaluate visibility against the viewport that existed before browser auto-scroll. */
  readonly originScrollTop?: number;
  readonly y?: 'nearest' | 'center' | 'center-if-outside' | 'start';
  readonly yMargin?: number;
  readonly schedule?: 'immediate' | 'next-frame';
}

interface ActiveScrollTarget {
  changedSinceFrame: boolean;
  frameScheduled: boolean;
  generation: number;
  isCurrent?: () => boolean;
  position: ScrollPosition;
  remainingFrames: number;
  stableFrames: number;
}

interface ViewportAnchorTokenRecord {
  anchor: ViewportDocumentAnchor;
  readonly interactionGeneration: number;
  readonly modeRoundTripSnapshot: {
    readonly editorMode: 'live' | 'source' | null;
    readonly owner: ViewportAnchorOwner;
    readonly scrollTop: number;
    returnEnabled: boolean;
    returned: boolean;
  } | null;
  readonly projectedOwners: Set<ViewportAnchorOwner>;
}

interface ModeTransitionChain {
  anchor: ViewportDocumentAnchor;
  readonly editorAnchors: Partial<Record<'live' | 'source', ViewportDocumentAnchor>>;
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
      anchor: ViewportDocumentAnchor;
      previousDocumentText: string;
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

function positionAtDocumentLine(text: string, requestedLine: number): number {
  const line = Math.max(1, Math.floor(Number.isFinite(requestedLine) ? requestedLine : 1));
  let position = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const nextBreak = text.indexOf('\n', position);
    if (nextBreak < 0) return text.length;
    position = nextBreak + 1;
  }
  return position;
}


const MAX_SETTLE_FRAMES = 8;
const REQUIRED_STABLE_FRAMES = 2;
// Chromium exposes fractional element geometry but rounds scrollTop to whole
// CSS pixels. Treat an adjacent-pixel correction as already stable so layout
// variants cannot make the viewport oscillate by one pixel on every toggle.
const POSITION_EPSILON = 1;
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
  private lastNativeScrollAt = Number.NEGATIVE_INFINITY;
  private lastScrollDirection: -1 | 0 | 1 = 0;
  private interactionGeneration = 0;
  private navigationGeneration = 0;
  private readonly activeNavigationReveals = new Set<NavigationRevealState>();
  private explicitNavigationGeneration = 0;
  private pendingNavigationTarget: { position: number; generation: number } | null = null;
  private scrollLockGeneration = 0;
  private activeScrollLockGeneration: number | null = null;
  private activeScrollLockCorrection: (() => void) | null = null;
  private elementRetentionGeneration = 0;
  private activeElementRetentionObserver: MutationObserver | null = null;
  private activeElementRetentionCorrection: (() => void) | null = null;
  private activeScrollTarget: ActiveScrollTarget | null = null;
  private activeLayoutAnchor: ActiveLayoutAnchor | null = null;
  private anchorStabilizationGeneration: number | null = null;
  private lastTouchY: number | null = null;
  private scrollbarDragActive = false;
  private scrollbarDragStartY: number | null = null;
  private nativeScrollbarBoundary: 'top' | 'bottom' | null = null;
  private pendingHistoryShortcutViewport: ViewportHistorySnapshot | null = null;
  private linkedPreviewEnabled = false;
  private linkedViewportDriver: ViewportAnchorOwner = 'editor';
  private lastViewportInteractionOwner: ViewportAnchorOwner = 'editor';
  private linkedProjectionGeneration = 0;
  private linkedViewportMap: LinkedViewportMap | null = null;
  private linkedViewportPosition: { source: number; preview: number } | null = null;
  private linkedViewportMapDirty = true;
  private linkedViewportMapRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private linkedInteractionUntil = Number.NEGATIVE_INFINITY;
  private linkedPreviewAttentionHeld = false;
  private readonly getMode: () => 'live' | 'source';
  private readonly previewSurface: PreviewViewportSurface | null;
  private readonly anchorTokens = new WeakMap<ViewportAnchorToken, ViewportAnchorTokenRecord>();
  private pendingDocumentPresentation: {
    readonly record: ViewportAnchorTokenRecord;
    readonly document: WeakRef<EditorView['state']['doc']>;
    readonly generation: number;
  } | null = null;
  private modeTransitionChain: ModeTransitionChain | null = null;
  private anchorTransactionScope: AnchorTransactionScope = IDLE_ANCHOR_TRANSACTION_SCOPE;
  private anchorMutationDepth = 0;
  private documentChangeDepth = 0;
  private pendingAsyncAnchorTransactions = 0;
  private readonly onWheel = (event: WheelEvent) => this.handleWheel(event);
  private readonly onScroll = () => {
    if (this.restoreNativeScrollbarBoundary()) {
      this.projectLinkedViewport('editor');
      return;
    }
    // Adopt the reading line after native scrolling, using the same layout
    // stabilizer as block updates. A newer interaction invalidates this anchor.
    if (this.getMode() === 'live' && this.isUserScrolling() &&
      this.view.scrollDOM.scrollTop > POSITION_EPSILON &&
      !this.scrollbarDragActive && !this.activeLayoutAnchor) {
      this.startInteractionLayoutStabilization({ from: -1, to: -1 });
    }
    const anchor = this.activeLayoutAnchor;
    if (anchor?.readingDocumentTop !== undefined) {
      const documentTop = this.readLayoutAnchorDocumentTop(anchor.position);
      if (documentTop !== null && Math.abs(documentTop - anchor.readingDocumentTop) <= POSITION_EPSILON
        && this.readingLayoutUnchanged(anchor)) {
        // A smooth/inertial tail can outlive its final wheel event. Only real
        // movement beyond the adopted position extends the gesture; our own
        // geometry corrections have already adopted their resulting scrollTop.
        if (Math.abs(this.view.scrollDOM.scrollTop - (anchor.readingScrollTop ?? this.view.scrollDOM.scrollTop)) > POSITION_EPSILON) {
          this.lastNativeScrollAt = performance.now();
        }
        this.adoptReadingLayout(anchor, documentTop);
        anchor.readingNativeAdopted = true;
        anchor.revision += 1;
      }
      this.restartLayoutStabilization();
    }
    this.scheduleActiveScrollFrame();
    this.projectLinkedViewport('editor');
  };
  private readonly onPointerDown = (event: PointerEvent) => this.handlePotentialLayoutInteraction(event);
  private readonly nativeInputViewport: NativeInputViewport;
  private readonly onPointerUp = (event: PointerEvent) => {
    this.finishScrollbarDrag(event.type === 'pointerup' ? event : undefined);
    if (event.type === 'pointerup') this.nativeInputViewport.capture(event.target);
  };
  private readonly onWindowBlur = () => this.finishScrollbarDrag();
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
  private readonly onKeyUp = (event: KeyboardEvent) => this.handleKeyUp(event);
  private readonly onNativeInput = (event: Event) => {
    const type = (event as InputEvent).inputType;
    if (type === 'historyUndo' || type === 'historyRedo') {
      this.nativeInputViewport.release();
      return;
    }
    if (!this.nativeInputViewport.hasOwner()) this.nativeInputViewport.capture(event.target);
  };
  private readonly onBeforeInput = (event: InputEvent) => {
    // Composition input need not have a preceding keydown. It must still retire
    // a wheel reading anchor before the edit can change the visible layout.
    if (this.activeLayoutAnchor?.readingDocumentTop !== undefined) this.activeLayoutAnchor = null;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.lastNativeScrollAt = Number.NEGATIVE_INFINITY;
    this.claimLinkedViewport('editor');
    this.navigationGeneration += 1;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') this.nativeInputViewport.release();
    else this.nativeInputViewport.capture(event.target);
  };
  private readonly onTouchStart = (event: TouchEvent) => this.handleTouchStart(event);
  private readonly onTouchMove = (event: TouchEvent) => this.handleTouchMove(event);
  private readonly onTouchEnd = () => this.finishTouchGesture();

  constructor(
    private readonly view: EditorView,
    options: ViewportControllerOptions = {}
  ) {
    this.nativeInputViewport = new NativeInputViewport(view);
    this.getMode = options.getMode ?? (() => 'live');
    this.previewSurface = options.previewSurface ?? null;
    controllerByDom.set(view.dom, this);
    if (options.attachInteractions !== false) {
      view.scrollDOM.addEventListener('wheel', this.onWheel, { passive: true });
      // CodeMirror's non-capture scroll observer may synchronously measure and
      // reconcile layout. Adopt native progress first so that reconciliation
      // cannot compensate from the previous scroll event's reading position.
      view.scrollDOM.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
      view.scrollDOM.addEventListener('touchstart', this.onTouchStart, { passive: true });
      view.scrollDOM.addEventListener('touchmove', this.onTouchMove, { passive: true });
      view.scrollDOM.addEventListener('touchend', this.onTouchEnd, { passive: true });
      view.scrollDOM.addEventListener('touchcancel', this.onTouchEnd, { passive: true });
      view.scrollDOM.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: true });
      view.scrollDOM.ownerDocument.addEventListener('pointerup', this.onPointerUp, true);
      view.scrollDOM.ownerDocument.addEventListener('pointercancel', this.onPointerUp, true);
      // Capture would also receive the textarea blur caused by grabbing the
      // scrollbar, ending its gesture before the native thumb starts moving.
      view.scrollDOM.ownerDocument.defaultView?.addEventListener('blur', this.onWindowBlur);
      view.dom.addEventListener('keydown', this.onKeyDown, true);
      view.dom.addEventListener('keyup', this.onKeyUp, true);
      view.dom.addEventListener('beforeinput', this.onBeforeInput, true);
      view.dom.addEventListener('input', this.onNativeInput);
      this.interactionsAttached = true;
    }
  }

  markInteraction(owner: ViewportAnchorOwner = 'editor'): void {
    const scope = this.anchorTransactionScope;
    const programmaticModeMutation = scope.kind === 'current'
      && this.isAnchorTokenCurrent(scope.record)
      && this.anchorMutationDepth > 0;
    if (!programmaticModeMutation) this.modeTransitionChain = null;
    this.lastViewportInteractionOwner = owner;
    this.claimLinkedViewport(owner);
    this.invalidateViewportWork();
  }

  private invalidateViewportWork(preserveInteractionGeneration = false): void {
    this.nativeScrollbarBoundary = null;
    this.nativeInputViewport.release();
    const scope = this.anchorTransactionScope;
    const programmaticCurrentTransaction = scope.kind === 'current'
      && this.isAnchorTokenCurrent(scope.record)
      && (this.anchorMutationDepth > 0 || this.documentChangeDepth > 0);
    if (!programmaticCurrentTransaction && !preserveInteractionGeneration) {
      this.interactionGeneration += 1;
    }
    this.navigationGeneration += 1;
    this.pendingNavigationTarget = null;
    this.scrollLockGeneration += 1;
    this.activeScrollLockGeneration = null;
    this.activeScrollLockCorrection = null;
    this.cancelElementRetention();
    this.generation += 1;
    this.activeScrollTarget = null;
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = null;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.lastNativeScrollAt = Number.NEGATIVE_INFINITY;
    this.lastTouchY = null;
  }

  getLastViewportInteractionOwner(): ViewportAnchorOwner {
    return this.lastViewportInteractionOwner;
  }

  /** Invalidates layout work while a captured mode token waits for final geometry. */
  markDeferredModeMutation(): void {
    this.invalidateViewportWork(true);
  }

  prepareModeRoundTripReturn(handle: ViewportAnchorToken): boolean {
    const record = this.anchorTokens.get(handle);
    if (!record || !this.isAnchorTokenCurrent(record) || !record.modeRoundTripSnapshot) return false;
    record.modeRoundTripSnapshot.returnEnabled = true;
    return true;
  }

  restoreModeRoundTripCaptureSurface(handle: ViewportAnchorToken): void {
    const record = this.anchorTokens.get(handle);
    const roundTrip = record?.modeRoundTripSnapshot;
    if (!record || !roundTrip?.returnEnabled || roundTrip.returned) return;
    this.runAnchorTransaction(handle, roundTrip.owner, () => undefined);
  }

  private markNavigationScrollStart(): void {
    this.modeTransitionChain = null;
    const scope = this.anchorTransactionScope;
    const programmaticCurrentTransaction = scope.kind === 'current'
      && this.isAnchorTokenCurrent(scope.record)
      && (this.anchorMutationDepth > 0 || this.documentChangeDepth > 0);
    if (!programmaticCurrentTransaction) {
      this.interactionGeneration += 1;
    }
    this.scrollLockGeneration += 1;
    this.activeScrollLockGeneration = null;
    this.activeScrollLockCorrection = null;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.lastNativeScrollAt = Number.NEGATIVE_INFINITY;
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
            ? {
                position: activeAnchor.position,
                viewportOffset: activeAnchor.viewportOffset,
                visualViewportOffset: activeAnchor.visualViewportOffset,
                readingDocumentTop: activeAnchor.readingDocumentTop,
                readingScrollTop: activeAnchor.readingScrollTop,
                readingHeightMapTop: activeAnchor.readingHeightMapTop,
                readingNativeAdopted: activeAnchor.readingNativeAdopted
              }
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
        if (this.hasActiveDocumentAnchorStabilization() || this.hasActiveNavigationReveal() || this.activeElementRetentionCorrection) {
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
  reconcileAfterEditorUpdate(
    mapPosition?: (position: number) => number,
    measuredLayout = true,
    externalDocumentPresentation = false
  ): void {
    // View updates emitted from CodeMirror's measurement pass run after its
    // internal height-map anchoring and before the browser paints. Reconcile an
    // active history lock here so no intermediate anchored position is visible.
    // External revisions collapse their text diff into one replacement, so
    // anchors inside it still need content-based relocation at scope completion.
    if (mapPosition && !externalDocumentPresentation && this.anchorTransactionScope.kind !== 'idle') {
      // Text similarity cannot locate repeated lines after disjoint edits.
      // Map every open scope while the exact CodeMirror change is available,
      // including parents of an awaited nested anchor transaction.
      const currentText = readDocumentTextProjection(this.view.state.doc);
      let scope: AnchorTransactionScope = this.anchorTransactionScope;
      while (scope.kind !== 'idle') {
        if (scope.kind === 'current' && !scope.closed) {
          scope.anchor = { ...scope.anchor, position: mapPosition(scope.anchor.position), sourceRange: undefined };
          scope.previousDocumentText = currentText;
          scope.documentChangeObserved = true;
        }
        scope = scope.parent;
      }
    }
    const nativeTop = this.nativeInputViewport.scrollTop();
    if (nativeTop !== null) {
      this.writeScrollPosition({ top: nativeTop, left: this.view.scrollDOM.scrollLeft });
      return;
    }
    if (this.restoreNativeScrollbarBoundary()) return;
    this.activeScrollLockCorrection?.();
    const activeAnchor = this.activeLayoutAnchor;
    if (activeAnchor) {
      if (mapPosition) activeAnchor.position = mapPosition(activeAnchor.position);
      // Transaction updates can precede CodeMirror's height-map anchoring.
      if (activeAnchor.readingDocumentTop !== undefined && measuredLayout) {
        const resolved = this.resolveLayoutAnchorTarget(activeAnchor);
        this.writeScrollPosition(resolved.target);
        if (resolved.readingDocumentTop !== undefined) {
          this.adoptReadingLayout(activeAnchor, resolved.readingDocumentTop);
        }
      }
      this.restartLayoutStabilization();
    }
    this.activeElementRetentionCorrection?.();
    const activeTarget = this.activeScrollTarget;
    if (!this.isActiveScrollTargetValid(activeTarget)) return;
    if (this.writeScrollPosition(activeTarget.position)) {
      activeTarget.changedSinceFrame = true;
    }
  }

  navigateBy(delta: ViewportScrollDelta): void {
    this.releaseLinkedPreviewAttention();
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
    this.startScrollTopLock(targetTop, isCurrent);
  }

  /** Holds a presentation's scroll offset without superseding its navigation intent. */
  retainScrollTop(targetTop: number, isCurrent: () => boolean = () => true): void {
    if (this.destroyed || !isCurrent()) return;
    this.startScrollTopLock(targetTop, isCurrent);
  }

  /** Retains one presentation element across a replacement without superseding its navigation intent. */
  retainElementTopWhileMutation(
    element: HTMLElement,
    resolveCurrentElement: () => HTMLElement | null,
    mutate: () => void,
    isCurrent: () => boolean = () => true,
    retainedTop?: number
  ): void {
    const beforeTop = retainedTop ?? (element.isConnected ? element.getBoundingClientRect().top : null);
    if (this.destroyed || beforeTop === null || !isCurrent()) {
      mutate();
      return;
    }
    this.cancelElementRetention();
    const retentionGeneration = ++this.elementRetentionGeneration;
    // A later document anchor or measured navigation owns scrolling. A still
    // focused table cell does not let its old width correction compete with it.
    const ownerGeneration = this.generation;
    // Rendered source/preview shells can commit one frame after the ordinary
    // CodeMirror settlement window. Keep this low-frequency transition bounded
    // while still covering that second layout phase.
    let remainingFrames = MAX_SETTLE_FRAMES * 2;
    const isRetentionCurrent = () => (
      !this.destroyed &&
      ownerGeneration === this.generation &&
      retentionGeneration === this.elementRetentionGeneration &&
      isCurrent()
    );
    const finish = () => {
      if (retentionGeneration !== this.elementRetentionGeneration) return;
      this.activeElementRetentionObserver?.disconnect();
      this.activeElementRetentionObserver = null;
      this.activeElementRetentionCorrection = null;
    };
    const reconcile = () => {
      if (!isRetentionCurrent()) {
        finish();
        return;
      }
      const currentElement = resolveCurrentElement();
      if (currentElement?.isConnected) {
        const current = this.readScrollPosition();
        const target = this.resolveScrollTarget({
          top: current.top + currentElement.getBoundingClientRect().top - beforeTop
        }, current);
        this.writeScrollPosition(target);
      }
    };
    const settleFrame = () => {
      if (!isRetentionCurrent()) { finish(); return; }
      reconcile();
      remainingFrames -= 1;
      if (remainingFrames > 0) requestAnimationFrame(settleFrame);
      else finish();
    };
    // Observer notifications may arrive dozens of times within one frame.
    // They correct geometry immediately without consuming the frame budget or
    // starting parallel settlement loops. Editor measurements use this owner too.
    this.activeElementRetentionCorrection = reconcile;
    const MutationObserverConstructor = element.ownerDocument.defaultView?.MutationObserver;
    if (MutationObserverConstructor) {
      this.activeElementRetentionObserver = new MutationObserverConstructor(() => reconcile());
      this.activeElementRetentionObserver.observe(this.view.dom, {
        attributes: true,
        childList: true,
        subtree: true
      });
    }
    mutate();
    if (!isRetentionCurrent()) {
      finish();
      return;
    }
    reconcile();
    requestAnimationFrame(settleFrame);
  }

  private cancelElementRetention(): void {
    this.elementRetentionGeneration += 1;
    this.activeElementRetentionObserver?.disconnect();
    this.activeElementRetentionObserver = null;
    this.activeElementRetentionCorrection = null;
  }

  private startScrollTopLock(targetTop: number, isCurrent: () => boolean): void {
    const lockGeneration = ++this.scrollLockGeneration;
    this.activeScrollLockGeneration = lockGeneration;
    let remainingFrames = MAX_SETTLE_FRAMES;
    const lockIsCurrent = () => (
      !this.destroyed &&
      lockGeneration === this.scrollLockGeneration &&
      isCurrent()
    );
    const finish = () => {
      if (this.activeScrollLockGeneration === lockGeneration) {
        this.activeScrollLockGeneration = null;
        this.activeScrollLockCorrection = null;
      }
    };
    const correctScrollTop = () => {
      if (!lockIsCurrent() || this.nativeInputViewport.hasOwner()) return;
      const nextScrollTop = Math.max(0, Math.min(
        targetTop,
        this.view.scrollDOM.scrollHeight - this.view.scrollDOM.clientHeight
      ));
      if (Math.abs(this.view.scrollDOM.scrollTop - nextScrollTop) > 0.1) {
        this.view.scrollDOM.scrollTop = nextScrollTop;
      }
    };
    const write = () => {
      if (!lockIsCurrent()) {
        finish();
        return;
      }
      correctScrollTop();
      remainingFrames -= 1;
      if (remainingFrames > 0 && isCurrent()) requestAnimationFrame(write);
      else finish();
    };
    this.activeScrollLockCorrection = correctScrollTop;
    write();
  }

  setLinkedPreviewEnabled(
    enabled: boolean,
    activationOwner: LinkedPreviewActivationOwner = 'editor'
  ): void {
    if (this.destroyed || this.linkedPreviewEnabled === enabled) return;
    this.linkedPreviewEnabled = enabled;
    if (!enabled) this.linkedPreviewAttentionHeld = false;
    if (enabled) {
      this.linkedViewportPosition = null;
      this.linkedViewportDriver = activationOwner === 'last-interaction'
        ? this.lastViewportInteractionOwner
        : activationOwner;
    }
    this.linkedProjectionGeneration += 1;
    this.linkedViewportMapDirty = true;
    if (this.linkedViewportMapRefreshTimer !== null) {
      clearTimeout(this.linkedViewportMapRefreshTimer);
      this.linkedViewportMapRefreshTimer = null;
    }
    if (enabled) {
      this.rebuildLinkedViewportMap(false);
      this.projectLinkedViewport(this.linkedViewportDriver);
    } else {
      this.linkedViewportMap = null;
    }
  }

  markPreviewInteraction(): void {
    this.releaseLinkedPreviewAttention();
    this.markInteraction('preview');
  }

  holdLinkedPreviewAttention(): void {
    if (this.destroyed || !this.linkedPreviewEnabled) return;
    this.linkedPreviewAttentionHeld = true;
    this.linkedProjectionGeneration += 1;
  }

  /** Aligns only the follower once; independent scrolling and the Source selection remain unchanged. */
  alignLinkedViewport(owner: ViewportAnchorOwner): boolean {
    if (this.destroyed || this.linkedPreviewEnabled || !this.previewSurface) return false;
    this.markInteraction(owner);
    const generation = this.navigationGeneration;
    const isCurrent = () => !this.destroyed && generation === this.navigationGeneration
      && !this.linkedPreviewEnabled;
    if (owner === 'editor' && this.previewSurface.isSourceLineRendered) {
      const position = this.getTopVisiblePosition();
      if (!this.previewSurface.isSourceLineRendered(position.line)) {
        this.previewSurface.restoreTopVisiblePosition(position, isCurrent);
        return true;
      }
    }
    const linkedMap = this.measureLinkedViewportMap();
    if (linkedMap && this.previewSurface.readScrollTop && this.previewSurface.writeScrollTop) {
      if (owner === 'editor') {
        this.previewSurface.writeScrollTop(linkedMap.sourceToPreview(this.view.scrollDOM.scrollTop));
      } else {
        this.writeScrollPosition({
          top: linkedMap.previewToSource(this.previewSurface.readScrollTop()),
          left: this.view.scrollDOM.scrollLeft
        });
      }
      return true;
    }
    if (owner === 'editor') {
      this.previewSurface.restoreTopVisiblePosition(this.getTopVisiblePosition(), isCurrent);
    } else {
      const position = this.previewSurface.captureTopVisiblePosition();
      if (!position) return false;
      this.restoreLinkedEditorPosition(position.line, position.editorLineOffset ?? position.lineOffset, isCurrent, position.sourceRange);
    }
    return true;
  }

  /** Treats back-to-top as one explicit navigation across the linked surfaces. */
  navigateLinkedToTop(owner: ViewportAnchorOwner): boolean {
    if (
      this.destroyed || !this.linkedPreviewEnabled ||
      !this.previewSurface?.writeScrollTop
    ) return false;
    this.markInteraction(owner);
    this.writeScrollPosition({
      top: 0,
      left: this.view.scrollDOM.scrollLeft
    });
    this.previewSurface.writeScrollTop(0);
    return true;
  }

  editorViewportChanged(): void {
    this.projectLinkedViewport('editor');
  }

  previewViewportChanged(): void {
    this.projectLinkedViewport('preview');
  }

  linkedPreviewReady(): void {
    this.linkedViewportMapDirty = true;
    this.scheduleLinkedViewportMapRefresh();
  }

  /** Keeps a Preview presentation update inside the current scroll owner's transaction. */
  runPreviewPresentationTransaction(
    mutate: () => void,
    documentChange?: PreviewDocumentChange
  ): void {
    if (this.destroyed) {
      mutate();
      return;
    }
    if (this.previewSurface?.readScrollTop && this.previewSurface.writeScrollTop) {
      if (this.previewSurface.isScrollbarDragging?.() ?? this.previewSurface.isInteracting?.()) {
        // Programmatic restoration can interrupt native scrollbar dragging.
        // Let the browser finish the gesture before refreshing the linked map.
        mutate();
        this.linkedViewportMapDirty = true;
        this.scheduleLinkedViewportMapRefresh();
        return;
      }
      const linkedPreviewEnabled = this.linkedPreviewEnabled;
      const heldPreviewTop = this.previewSurface.readScrollTop();
      const restoreVisualAnchor = this.previewSurface.captureVisualReadingAnchor?.(documentChange ? 0 : 1 / 3);
      const interactionGeneration = this.interactionGeneration;
      const projectionGeneration = this.linkedProjectionGeneration;
      const projectionDriver = this.linkedViewportDriver;
      const previewGestureActive = linkedPreviewEnabled && projectionDriver === 'preview' && this.isLinkedInteractionActive();
      let readingAnchor: ViewportDocumentAnchor | null = null;
      // Source scrolling cannot displace an independently scrolled Preview.
      if ((!linkedPreviewEnabled || !this.isUserScrolling()) && !previewGestureActive) {
        if (documentChange) {
          const topAnchor = this.capturePreviewDocumentAnchor(0, undefined, documentChange.previousText);
          const changedRange = findChangedDocumentRange(
            documentChange.previousText,
            documentChange.nextText
          );
          // Edits inside or below the visible surface should not turn typing into
          // viewport motion. Only an upstream edit can displace the current view;
          // in that case preserve the semantic element at the top edge.
          if (topAnchor && changedRange && changedRange.previousTo <= topAnchor.position) {
            readingAnchor = topAnchor;
          }
        } else {
          const readingBand = this.capturePreviewDocumentAnchor(undefined, 1 / 3);
          // Reading bands inside content keep their relative point during preset
          // reflow. Only a freshly interpolated whitespace line needs the exact
          // top edge; retained mode-transition projections keep their reading band.
          readingAnchor = readingBand?.interpolatedWhitespace
            ? this.capturePreviewDocumentAnchor()
            : readingBand;
        }
      }
      mutate();
      this.linkedViewportMapDirty = true;
      // Async Preview presentation commits can change the height of content above
      // the reading point. When Source owns an idle viewport, project the semantic
      // position sampled from Preview against the committed geometry
      // in the same frame. Content refreshes map that anchor through the text diff;
      // presentation-only commits retain its exact rendered-range progress. During
      // a scroll gesture, preserve the physical follower position so layout cannot
      // fight the user's input.
      // The reading DOM can survive a morph or resource update. Its exact
      // painted point takes priority over interpolated source-range geometry.
      const visualRestored = restoreVisualAnchor?.() === true;
      if (!visualRestored && readingAnchor) {
        const projectedAnchor = documentChange
          ? this.mapAnchorThroughDocumentChange(
              readingAnchor,
              documentChange.previousText,
              documentChange.nextText
            )
          : readingAnchor;
        if (!projectedAnchor) {
          this.previewSurface.writeScrollTop(heldPreviewTop);
          this.scheduleLinkedViewportMapRefresh();
          return;
        }
        const line = this.view.state.doc.lineAt(
          Math.min(Math.max(0, projectedAnchor.position), this.view.state.doc.length)
        );
        this.previewSurface.restoreTopVisiblePosition({
          line: line.number,
          lineOffset: projectedAnchor.lineOffset,
          viewportOffset: projectedAnchor.viewportOffset,
          sourceRange: projectedAnchor.sourceRange
        }, () => (
          !this.destroyed && this.linkedPreviewEnabled === linkedPreviewEnabled &&
          interactionGeneration === this.interactionGeneration &&
          projectionGeneration === this.linkedProjectionGeneration &&
          (!linkedPreviewEnabled || this.linkedViewportDriver === projectionDriver)
        ));
      } else if (!visualRestored) {
        this.previewSurface.writeScrollTop(heldPreviewTop);
      }
      // Pin the refreshed hot-path map to the exact post-commit position so the
      // next wheel delta continues from this frame without a correction.
      this.rebuildLinkedViewportMap(true);
      this.scheduleLinkedViewportMapRefresh();
      return;
    }
    const owner = this.linkedPreviewEnabled ? this.linkedViewportDriver : 'preview';
    const handle = this.captureAnchorToken(owner);
    if (!handle) {
      mutate();
      return;
    }
    this.runAnchorTransaction(handle, 'preview', () => mutate());
  }

  private projectLinkedViewport(owner: ViewportAnchorOwner): void {
    if (
      this.destroyed || !this.linkedPreviewEnabled || !this.previewSurface ||
      this.linkedViewportDriver !== owner
    ) return;
    if (owner === 'editor' && this.linkedPreviewAttentionHeld) return;
    const generation = this.linkedProjectionGeneration;
    if (
      this.destroyed || !this.linkedPreviewEnabled || !this.previewSurface ||
      generation !== this.linkedProjectionGeneration || this.linkedViewportDriver !== owner
    ) return;
    const linkedMap = this.linkedViewportMap;
    if (
      linkedMap && this.previewSurface.readScrollTop && this.previewSurface.writeScrollTop
    ) {
      if (owner === 'editor') {
        this.previewSurface.writeScrollTop(linkedMap.sourceToPreview(this.view.scrollDOM.scrollTop));
      } else {
        this.writeScrollPosition({
          top: linkedMap.previewToSource(this.previewSurface.readScrollTop()),
          left: this.view.scrollDOM.scrollLeft
        });
      }
      this.linkedViewportPosition = {
        source: this.view.scrollDOM.scrollTop,
        preview: this.previewSurface.readScrollTop()
      };
      return;
    }
    const position = { source: this.view.scrollDOM.scrollTop, preview: this.previewSurface.readScrollTop?.() ?? 0 };
    const previous = this.linkedViewportPosition;
    if (previous && (owner === 'editor' || this.previewSurface.readScrollTop)
      && Math.abs(owner === 'editor' ? position.source - previous.source : position.preview - previous.preview) <= POSITION_EPSILON) return;
    this.linkedViewportPosition = position;
    // A later scroll in the same drag supersedes an earlier cold destination,
    // even when the new destination is already mounted. Idle geometry does not
    // repeat this request and cannot turn input into semantic navigation.
    const semanticGeneration = ++this.linkedProjectionGeneration;
    if (owner === 'editor') {
      if (position.source <= POSITION_EPSILON && this.previewSurface.writeScrollTop) {
        this.previewSurface.writeScrollTop(0);
        return;
      }
      const sourcePosition = this.getTopVisiblePosition();
      this.previewSurface.restoreTopVisiblePosition(sourcePosition, () => (
        !this.destroyed && this.linkedPreviewEnabled &&
        semanticGeneration === this.linkedProjectionGeneration && this.linkedViewportDriver === 'editor'
      ));
      return;
    }
    const previewPosition = this.previewSurface.captureTopVisiblePosition();
    if (!previewPosition) return;
    this.restoreLinkedEditorPosition(
      previewPosition.line,
      previewPosition.editorLineOffset ?? previewPosition.lineOffset,
      () => (
        !this.destroyed && this.linkedPreviewEnabled &&
        semanticGeneration === this.linkedProjectionGeneration && this.linkedViewportDriver === 'preview'
      ),
      previewPosition.sourceRange
    );
  }

  private claimLinkedViewport(owner: ViewportAnchorOwner): void {
    if (!this.linkedPreviewEnabled) return;
    if (this.linkedViewportDriver !== owner) {
      this.linkedViewportPosition = null;
      this.linkedProjectionGeneration += 1;
    }
    this.linkedViewportDriver = owner;
    this.linkedInteractionUntil = this.readClock() + WHEEL_GESTURE_IDLE_MS;
  }

  private releaseLinkedPreviewAttention(): void {
    if (!this.linkedPreviewAttentionHeld) return;
    this.linkedPreviewAttentionHeld = false;
    this.linkedProjectionGeneration += 1;
    this.linkedViewportMapDirty = true;
    this.rebuildLinkedViewportMap(true);
  }

  private readClock(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private isLinkedInteractionActive(): boolean {
    return this.readClock() < this.linkedInteractionUntil
      || this.linkedViewportDriver === 'preview' && this.previewSurface?.isInteracting?.() === true;
  }

  private scheduleLinkedViewportMapRefresh(): void {
    if (this.destroyed || !this.linkedPreviewEnabled) return;
    if (this.linkedViewportMapRefreshTimer !== null) clearTimeout(this.linkedViewportMapRefreshTimer);
    const delay = Math.max(this.previewSurface?.isInteracting?.() ? WHEEL_GESTURE_IDLE_MS : 0,
      this.linkedInteractionUntil - this.readClock());
    this.linkedViewportMapRefreshTimer = setTimeout(() => {
      this.linkedViewportMapRefreshTimer = null;
      if (this.destroyed || !this.linkedPreviewEnabled) return;
      if (this.isLinkedInteractionActive()) {
        this.scheduleLinkedViewportMapRefresh();
        return;
      }
      this.rebuildLinkedViewportMap(true);
    }, delay);
  }

  private measureLinkedViewportMap(pinnedPoint?: LinkedViewportPoint): LinkedViewportMap | null {
    const geometry = this.previewSurface?.captureLinkedGeometry?.();
    if (!geometry) return null;
    const sourceMaximum = Math.max(0, this.view.scrollDOM.scrollHeight - this.view.scrollDOM.clientHeight);
    const points: LinkedViewportPoint[] = [];
    for (const region of geometry.regions) {
      const startLineNumber = Math.min(
        Math.max(1, region.startLine),
        this.view.state.doc.lines
      );
      const endLineNumber = Math.min(
        Math.max(startLineNumber, region.endLine),
        this.view.state.doc.lines
      );
      const startLine = this.view.state.doc.line(startLineNumber);
      const endLine = this.view.state.doc.line(endLineNumber);
      const startBlock = this.view.lineBlockAt(startLine.from);
      const endBlock = this.view.lineBlockAt(endLine.from);
      points.push(
        { source: startBlock.top, preview: region.top },
        { source: endBlock.bottom, preview: region.bottom }
      );
    }
    return createLinkedViewportMap(points, {
      sourceMaximum,
      previewMaximum: Math.max(0, geometry.maximumScrollTop)
    }, pinnedPoint);
  }

  private rebuildLinkedViewportMap(project: boolean): void {
    if (this.destroyed || !this.linkedPreviewEnabled || !this.linkedViewportMapDirty) return;
    const currentPosition = this.previewSurface?.readScrollTop ? {
      source: this.view.scrollDOM.scrollTop,
      preview: this.previewSurface.readScrollTop()
    } : null;
    const driverPositionUnchanged = currentPosition && this.linkedViewportPosition && Math.abs(
      this.linkedViewportDriver === 'editor'
        ? currentPosition.source - this.linkedViewportPosition.source
        : currentPosition.preview - this.linkedViewportPosition.preview
    ) <= POSITION_EPSILON;
    // A timer may run before the driver's native scroll event. Pinning that
    // new position to its old follower would freeze a real scroll into the map.
    const pinnedPoint = project && this.linkedViewportMap && driverPositionUnchanged
      ? currentPosition ?? undefined
      : undefined;
    const linkedMap = this.measureLinkedViewportMap(pinnedPoint);
    if (this.linkedViewportMap && !linkedMap) this.linkedViewportPosition = null;
    this.linkedViewportMap = linkedMap;
    this.linkedViewportMapDirty = false;
    if (project) this.projectLinkedViewport(this.linkedViewportDriver);
  }

  private restoreLinkedEditorPosition(
    lineNumber: number,
    lineOffset: number,
    isCurrent: () => boolean,
    sourceRange?: ViewportDocumentAnchor['sourceRange']
  ): void {
    // A linked follower tracks the current gesture, not an asynchronous layout
    // mutation. One measured write avoids the generic multi-frame stabilizer
    // chasing a Preview gesture after it has already advanced.
    if (!isCurrent()) return;
    const normalizedLine = Math.min(
      Math.max(1, Math.floor(Number.isFinite(lineNumber) ? lineNumber : 1)),
      this.view.state.doc.lines
    );
    let line = this.view.state.doc.line(normalizedLine);
    let offset = Number.isFinite(lineOffset) ? Math.max(0, lineOffset) : 0;
    if (sourceRange && this.getMode() === 'source') {
      const start = Math.min(this.view.state.doc.lines, Math.max(1, Math.floor(sourceRange.startLine)));
      const end = Math.min(this.view.state.doc.lines, Math.max(start, Math.floor(sourceRange.endLine)));
      const progress = Math.max(0, Math.min(1, sourceRange.progress));
      const span = end - start + 1, position = span * progress;
      const index = Math.min(span - 1, Math.floor(position));
      line = this.view.state.doc.line(start + index);
      const block = this.view.lineBlockAt(line.from);
      offset = (block.bottom - block.top) * (progress >= 1 ? 1 : position - index);
    }
    const target = this.resolveScrollTarget({
      top: this.view.lineBlockAt(line.from).top + offset
    }, this.readScrollPosition());
    if (isCurrent()) this.writeScrollPosition(target);
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
    const canInspectLayout = this.getMode() === 'live'
      && typeof this.view.scrollDOM.getBoundingClientRect === 'function'
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
          lineOffset: Math.max(0, scrollerRect.top - rect.top),
          renderedBlock: true
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
    { force = false, requiredStableFrames }: RestoreDocumentAnchorOptions = {}
  ): void {
    if (!force && this.isUserScrolling()) return;
    const position = Math.min(Math.max(0, anchor.position), this.view.state?.doc?.length ?? anchor.position);
    const lineOffset = Number.isFinite(anchor.lineOffset) ? Math.max(0, anchor.lineOffset) : 0;
    const viewportOffset = Number.isFinite(anchor.viewportOffset)
      ? Math.max(0, anchor.viewportOffset ?? 0)
      : null;
    this.stabilize(() => {
      if (anchor.sourceRange && viewportOffset !== null && !anchor.preciseTextPosition) {
        const startLine = Math.min(
          Math.max(1, Math.floor(anchor.sourceRange.startLine)),
          this.view.state.doc.lines
        );
        const endLine = Math.min(
          Math.max(startLine, Math.floor(anchor.sourceRange.endLine)),
          this.view.state.doc.lines
        );
        const progress = Math.max(0, Math.min(1, anchor.sourceRange.progress));
        if (this.getMode() === 'live' && typeof this.view.contentDOM?.querySelectorAll === 'function') {
          const renderedBlock = Array.from(
            this.view.contentDOM.querySelectorAll<HTMLElement>(
              '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
            )
          ).find((block) => (
            Number(block.dataset.meoRenderedBlockStartLine) === startLine
            && Number(block.dataset.meoRenderedBlockEndLine) === endLine
          ));
          if (renderedBlock) {
            const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
            const blockRect = renderedBlock.getBoundingClientRect();
            return {
              top: Math.max(
                0,
                this.view.scrollDOM.scrollTop + blockRect.top - scrollerRect.top
                  + blockRect.height * progress - viewportOffset
              )
            };
          }
        }
        if (this.getMode() === 'source') {
          const lineSpan = Math.max(1, endLine - startLine + 1);
          const rangeOffset = lineSpan * progress;
          const lineIndex = Math.min(lineSpan - 1, Math.floor(rangeOffset));
          const lineNumber = startLine + lineIndex;
          const lineProgress = progress >= 1
            ? 1
            : Math.max(0, Math.min(1, rangeOffset - lineIndex));
          const block = this.view.lineBlockAt(this.view.state.doc.line(lineNumber).from);
          return {
            top: Math.max(0, block.top + block.height * lineProgress - viewportOffset)
          };
        }
      }
      if (anchor.renderedBlock && typeof this.view.contentDOM?.querySelectorAll === 'function') {
        const lineNumber = this.view.state.doc.lineAt(position).number;
        const renderedBlock = Array.from(
          this.view.contentDOM.querySelectorAll<HTMLElement>('[data-meo-rendered-block-start-line]')
        ).find((block) => Number(block.dataset.meoRenderedBlockStartLine) === lineNumber);
        if (renderedBlock) {
          const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
          const blockRect = renderedBlock.getBoundingClientRect();
          return {
            top: Math.max(
              0,
              this.view.scrollDOM.scrollTop + blockRect.top - scrollerRect.top + lineOffset
            )
          };
        }
      }
      if (
        viewportOffset !== null && this.getMode() === 'live'
        && typeof this.view.contentDOM?.querySelectorAll === 'function'
      ) {
        const lineNumber = this.view.state.doc.lineAt(position).number;
        const renderedBlock = Array.from(
          this.view.contentDOM.querySelectorAll<HTMLElement>(
            '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
          )
        ).find((block) => {
          const startLine = Number(block.dataset.meoRenderedBlockStartLine);
          const endLine = Number(block.dataset.meoRenderedBlockEndLine);
          return Number.isInteger(startLine) && Number.isInteger(endLine)
            && lineNumber >= startLine && lineNumber <= endLine;
        });
        if (renderedBlock) {
          const startLine = Number(renderedBlock.dataset.meoRenderedBlockStartLine);
          const endLine = Number(renderedBlock.dataset.meoRenderedBlockEndLine);
          const progress = Math.max(0, Math.min(
            1,
            (lineNumber - startLine) / Math.max(1, endLine - startLine)
          ));
          const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
          const blockRect = renderedBlock.getBoundingClientRect();
          return {
            top: Math.max(
              0,
              this.view.scrollDOM.scrollTop + blockRect.top - scrollerRect.top
                + blockRect.height * progress - viewportOffset
            )
          };
        }
      }
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
      // Offscreen lines do not have DOM coordinates yet. Preserve the same
      // reading band using the height map until the line is rendered.
      if (anchor.preciseTextPosition && viewportOffset !== null) {
        const block = this.view.lineBlockAt(position), line = this.view.state.doc.lineAt(position);
        return { top: Math.max(0, block.top + block.height * (position - line.from) / Math.max(1, line.length) - viewportOffset) };
      }
      return {
        top: Math.max(0, this.view.lineBlockAt(position).top + (
          viewportOffset === null ? lineOffset : -viewportOffset
        ))
      };
    }, { onSettled, requiredStableFrames });
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

  preserveDocumentAnchorWhileMutation(mutate: () => void, immediateLayout = false): void {
    const anchor = this.captureDocumentAnchor();
    // A new font layout supersedes absolute scroll retention from a block-mode
    // transition; that older target would otherwise pull this anchor away.
    if (immediateLayout && !this.isUserScrolling()) this.beginNavigationReveal();
    const scroller = this.view.scrollDOM;
    const scrollerRect = immediateLayout ? scroller.getBoundingClientRect() : null;
    const visibleTable = scrollerRect && Array.from(
      this.view.contentDOM.querySelectorAll<HTMLElement>('.meo-md-html-table-shell')
    ).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top <= scrollerRect.top + 2 && rect.bottom > scrollerRect.top + 2;
    });
    const tableRows = visibleTable ? Array.from(visibleTable.querySelectorAll<HTMLElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr[data-source-line-number]'
    )) : [];
    const tableRowIndex = scrollerRect ? (() => {
      const rowAtTop = tableRows.findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top <= scrollerRect.top + 2 && rect.bottom > scrollerRect.top + 2;
      });
      if (rowAtTop >= 0) return rowAtTop;
      const bodyRow = tableRows.findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return element.parentElement?.tagName === 'TBODY'
          && rect.bottom > scrollerRect.top + 2 && rect.top < scrollerRect.bottom;
      });
      return bodyRow >= 0 ? bodyRow : tableRows.findIndex((element) => (
        element.getBoundingClientRect().bottom > scrollerRect.top + 2
      ));
    })() : -1;
    const tableRow = tableRows[tableRowIndex];
    const bodyRow = tableRow?.dataset.tableBodyRow;
    const resolveTableRow = () => {
      if (tableRow?.isConnected) return tableRow;
      const shell = this.view.contentDOM.querySelector<HTMLElement>(
        `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${visibleTable?.dataset.meoRenderedBlockStartLine}"]`
      );
      const body = shell?.querySelector<HTMLTableSectionElement>('table[data-meo-table-windowed] > tbody');
      if (body && bodyRow !== undefined) return tableRowWindowFor(body)?.ensure(Number(bodyRow)) ?? null;
      return shell?.querySelectorAll<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr[data-source-line-number]'
      )[tableRowIndex] ?? null;
    };
    const visibleBlock = tableRow ?? (scrollerRect && Array.from(
      this.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line, [data-meo-rendered-block-start-line]')
    ).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 2 && rect.top < scrollerRect.bottom;
    }));
    const blockTop = visibleBlock?.getBoundingClientRect().top;
    const fontAnchorPosition = immediateLayout && scrollerRect
      ? this.view.posAtCoords({ x: scrollerRect.left + 100, y: scrollerRect.top + 2 }) ?? anchor.position
      : anchor.position;
    const foldedCodeNearTop = immediateLayout && scrollerRect && Array.from(
      this.view.contentDOM.querySelectorAll<HTMLElement>('.meo-md-long-code-placeholder')
    ).find((element) => {
      const rect = element.getBoundingClientRect();
      const blockLine = Number(element.dataset.meoRenderedBlockStartLine);
      const anchorLine = this.view.state.doc.lineAt(fontAnchorPosition).number;
      const atTop = this.view.scrollDOM.ownerDocument.elementFromPoint(
        scrollerRect.left + 100, scrollerRect.top + 2
      )?.closest('.meo-md-long-code-placeholder') === element;
      return rect.top <= scrollerRect.top + 2 && (
        atTop || (
          rect.bottom >= scrollerRect.top - 96 && Math.abs(blockLine - anchorLine) <= 15
        )
      );
    });
    const resolveAnchorLine = (): HTMLElement | null => {
      try {
        const node = this.view.domAtPos(fontAnchorPosition).node;
        const element = node instanceof HTMLElement ? node : node.parentElement;
        const line = element?.closest<HTMLElement>('.cm-line') ?? null;
        return line?.closest('.cm-editor') === this.view.dom ? line : null;
      } catch {
        return null;
      }
    };
    const anchorLine = !tableRow ? resolveAnchorLine() : null;
    const resolveTrackedAnchorLine = () => resolveAnchorLine() ?? (anchorLine?.isConnected ? anchorLine : null);
    const anchorLineRect = anchorLine?.getBoundingClientRect();
    const anchorLineTop = anchorLineRect && scrollerRect
      && anchorLineRect.bottom > scrollerRect.top && anchorLineRect.top < scrollerRect.bottom
        ? anchorLineRect.top : null;
    const topRenderedBlock = immediateLayout && scrollerRect
      ? this.view.scrollDOM.ownerDocument.elementFromPoint(
        scrollerRect.left + 100, scrollerRect.top + 2
      )?.closest<HTMLElement>('.meo-rendered-block-preview, .meo-md-html-block') ?? null
      : null;
    const visualAnchor = !tableRow ? foldedCodeNearTop || topRenderedBlock : null;
    const resolveVisualAnchor = () => visualAnchor?.isConnected ? visualAnchor : visualAnchor
      ? this.view.contentDOM.querySelector<HTMLElement>(
        `.${visualAnchor.classList.contains('meo-md-long-code-placeholder') ? 'meo-md-long-code-placeholder' : visualAnchor.classList.contains('meo-md-html-block') ? 'meo-md-html-block' : 'meo-rendered-block-preview'}[data-meo-rendered-block-start-line="${visualAnchor.dataset.meoRenderedBlockStartLine}"]`
      ) : null;
    const visualTop = visualAnchor?.getBoundingClientRect().top;
    mutate();
    // Keep the visible source position in CodeMirror's virtual viewport while
    // preceding tall blocks acquire their new font-dependent height.
    if (immediateLayout && (this.getMode() === 'source' || foldedCodeNearTop || (!tableRow && anchorLineTop !== null)
      || topRenderedBlock?.querySelector('.meo-mermaid-toolbar'))) queueMicrotask(() => {
      if (!this.destroyed && !this.isUserScrolling()) this.view.dispatch({
        effects: editorScrollIntoView(fontAnchorPosition, { y: 'nearest' })
      });
    });
    const currentBlock = tableRow ? resolveTableRow() : visualAnchor
      ? resolveVisualAnchor() : anchorLineTop !== null ? resolveTrackedAnchorLine() : visibleBlock;
    const targetTop = visualTop ?? anchorLineTop ?? blockTop;
    if (currentBlock?.isConnected && targetTop !== undefined && targetTop !== null && !this.isUserScrolling()) {
      // Font changes reflow the DOM before CodeMirror updates its height map.
      // Correct the first layout now, before later height-map measurements settle.
      this.writeScrollPosition({
        top: scroller.scrollTop + currentBlock.getBoundingClientRect().top - targetTop,
        left: scroller.scrollLeft
      });
    }
    if (tableRow && blockTop !== undefined && !this.isUserScrolling()) {
      const ownerGeneration = this.generation + 1;
      const correctTableRow = () => {
        if (this.destroyed || this.generation !== ownerGeneration || this.isUserScrolling()) return;
        const row = resolveTableRow();
        if (row) this.writeScrollPosition({
          top: scroller.scrollTop + row.getBoundingClientRect().top - blockTop,
          left: scroller.scrollLeft
        });
      };
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(correctTableRow);
      observer?.observe(this.view.contentDOM);
      const mutations = new MutationObserver(correctTableRow);
      mutations.observe(this.view.contentDOM, { childList: true, attributes: true, subtree: true });
      scroller.addEventListener('scroll', correctTableRow, { passive: true });
      let remainingFrames = 15;
      const release = () => {
        if (--remainingFrames <= 0 || this.destroyed || this.generation !== ownerGeneration) {
          observer?.disconnect();
          mutations.disconnect();
          scroller.removeEventListener('scroll', correctTableRow);
        } else requestAnimationFrame(release);
      };
      requestAnimationFrame(release);
      this.stabilize(() => {
        const row = resolveTableRow();
        return row ? { top: scroller.scrollTop + row.getBoundingClientRect().top - blockTop } : null;
      }, { requiredStableFrames: 12 });
      return;
    }
    if (!visualAnchor && anchorLineTop !== null && currentBlock?.isConnected && !this.isUserScrolling()) {
      const ownerGeneration = this.generation + 1;
      const trackedLineTarget = () => {
        const line = resolveTrackedAnchorLine();
        if (line) return scroller.scrollTop + line.getBoundingClientRect().top - anchorLineTop;
        return this.getMode() === 'live'
          ? this.view.lineBlockAt(fontAnchorPosition).top - (anchorLineTop - scrollerRect!.top)
          : null;
      };
      const correctAnchorLine = () => {
        if (this.destroyed || this.generation !== ownerGeneration || this.isUserScrolling()) return;
        const top = trackedLineTarget();
        if (top !== null) this.writeScrollPosition({ top, left: scroller.scrollLeft });
      };
      scroller.addEventListener('scroll', correctAnchorLine, { passive: true });
      const mutations = new MutationObserver(correctAnchorLine);
      mutations.observe(this.view.contentDOM, { childList: true, attributes: true, subtree: true });
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(correctAnchorLine);
        // CodeMirror can resize a preceding rendered block after its height
        // map has settled. ResizeObserver runs before that frame is painted.
        observer.observe(this.view.contentDOM);
        let remainingFrames = 15;
        const release = () => {
          if (--remainingFrames <= 0 || this.destroyed || this.generation !== ownerGeneration) {
            observer.disconnect();
            mutations.disconnect();
            scroller.removeEventListener('scroll', correctAnchorLine);
          }
          else requestAnimationFrame(release);
        };
        requestAnimationFrame(release);
      } else {
        requestAnimationFrame(() => {
          mutations.disconnect();
          scroller.removeEventListener('scroll', correctAnchorLine);
        });
      }
      this.stabilize(() => {
        const top = trackedLineTarget();
        return top === null ? null : { top };
      }, { requiredStableFrames: 12 });
      return;
    }
    if (visualAnchor && visualTop !== undefined && currentBlock?.isConnected && !this.isUserScrolling()) {
      const ownerGeneration = this.generation + 1;
      const correctVisualAnchor = () => {
        if (this.generation !== ownerGeneration || this.activeElementRetentionCorrection !== correctVisualAnchor) return;
        const current = resolveVisualAnchor();
        if (current && !this.destroyed && !this.isUserScrolling()) this.writeScrollPosition({
          top: scroller.scrollTop + current.getBoundingClientRect().top - visualTop,
          left: scroller.scrollLeft
        });
      };
      // CodeMirror's measured update can adjust scrolling after DOM observers
      // run. Reconcile this font anchor in that same pre-paint update too.
      this.activeElementRetentionCorrection = correctVisualAnchor;
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
        correctVisualAnchor();
      });
      observer?.observe(this.view.contentDOM);
      const mutations = new MutationObserver(correctVisualAnchor);
      mutations.observe(this.view.contentDOM, { childList: true, attributes: true, subtree: true });
      scroller.addEventListener('scroll', correctVisualAnchor, { passive: true });
      let remainingFrames = 8;
      const release = () => {
        if (--remainingFrames <= 0 || this.destroyed || this.generation !== ownerGeneration
          || this.activeElementRetentionCorrection !== correctVisualAnchor) {
          if (this.activeElementRetentionCorrection === correctVisualAnchor) {
            this.activeElementRetentionCorrection = null;
          }
          observer?.disconnect();
          mutations.disconnect();
          scroller.removeEventListener('scroll', correctVisualAnchor);
        } else requestAnimationFrame(release);
      };
      requestAnimationFrame(release);
      this.stabilize(() => resolveVisualAnchor()
        ? { top: scroller.scrollTop + resolveVisualAnchor()!.getBoundingClientRect().top - visualTop }
        : null, { requiredStableFrames: 7 });
      return;
    }
    this.restoreDocumentAnchor(anchor, undefined, immediateLayout ? { requiredStableFrames: 7 } : {});
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

  preserveElementPositionWhileMutation(
    element: HTMLElement,
    resolveCurrentElement: () => HTMLElement | null,
    mutate: () => void,
    schedule: StabilizeOptions['schedule'] = 'next-frame',
    waitForReplacement = false
  ): void {
    const beforeTop = element.isConnected ? element.getBoundingClientRect().top : null;
    mutate();
    if (beforeTop === null || this.isUserScrolling()) return;
    this.stabilize(() => {
      const current = resolveCurrentElement();
      if (!current?.isConnected) return null;
      return {
        top: this.view.scrollDOM.scrollTop + current.getBoundingClientRect().top - beforeTop
      };
    }, {
      schedule,
      canSettle: waitForReplacement
        ? () => resolveCurrentElement() !== element
        : undefined,
      requiredStableFrames: waitForReplacement ? 4 : undefined
    });
  }

  /** Reveals through the owned scroller; pending geometry never displaces the current viewport owner. */
  revealElement(
    element: HTMLElement,
    isCurrent: () => boolean = () => true,
    { yMargin = 0 }: { yMargin?: number } = {}
  ): void {
    this.runNavigationReveal(() => {
      if (!element.isConnected) return { kind: 'unavailable' };
      const scrollerRect = editorViewportBounds(this.view);
      const elementRect = element.getBoundingClientRect();
      const margin = Math.min(
        Math.max(0, yMargin),
        Math.max(0, (
          (scrollerRect.bottom - scrollerRect.top) - (elementRect.bottom - elementRect.top)
        ) / 2)
      );
      const nearestEdge = (startDelta: number, endDelta: number): 'start' | 'end' | null => {
        if (startDelta >= 0 && endDelta <= 0) return null;
        if (startDelta < 0 && endDelta > 0) {
          return Math.abs(startDelta) <= endDelta ? 'start' : 'end';
        }
        return startDelta < 0 ? 'start' : 'end';
      };
      const verticalEdge = nearestEdge(
        elementRect.top - scrollerRect.top - margin,
        elementRect.bottom - scrollerRect.bottom + margin
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
                ? elementRect.top - scrollerRect.top - margin
                : elementRect.bottom - scrollerRect.bottom + margin
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

  /** Reveals measured caret-like geometry and keeps remeasuring while surrounding layout settles. */
  revealVerticalBounds(
    readBounds: () => { top: number; bottom: number } | null,
    isCurrent: () => boolean = () => true,
    {
      yMargin = 0,
      y = 'nearest',
      readViewportBounds,
      originScrollTop
    }: {
      yMargin?: number;
      y?: 'nearest' | 'center-if-outside';
      readViewportBounds?: () => { top: number; bottom: number };
      originScrollTop?: number;
    } = {}
  ): void {
    this.runNavigationReveal(() => {
      const bounds = readBounds();
      if (!bounds) return { kind: 'unavailable' };
      const current = this.readScrollPosition();
      const scrollerRect = readViewportBounds?.() ?? editorViewportBounds(this.view);
      const evaluationTop = Number.isFinite(originScrollTop)
        ? Math.max(0, originScrollTop as number)
        : current.top;
      const projectedTop = bounds.top + current.top - evaluationTop;
      const projectedBottom = bounds.bottom + current.top - evaluationTop;
      const margin = Math.min(
        Math.max(0, yMargin),
        Math.max(0, ((scrollerRect.bottom - scrollerRect.top) - (bounds.bottom - bounds.top)) / 2)
      );
      const topDelta = projectedTop - scrollerRect.top - margin;
      const bottomDelta = projectedBottom - scrollerRect.bottom + margin;
      if (topDelta >= 0 && bottomDelta <= 0) {
        return Math.abs(current.top - evaluationTop) <= POSITION_EPSILON
          ? { kind: 'stable' }
          : { kind: 'target', target: { top: evaluationTop } };
      }
      if (y === 'center-if-outside') {
        return {
          kind: 'target',
          target: {
            top: evaluationTop + (projectedTop + projectedBottom - scrollerRect.top - scrollerRect.bottom) / 2
          }
        };
      }
      const delta = topDelta < 0 && bottomDelta > 0
        ? (Math.abs(topDelta) <= bottomDelta ? topDelta : bottomDelta)
        : topDelta < 0 ? topDelta : bottomDelta;
      return { kind: 'target', target: { top: evaluationTop + delta } };
    }, { settle: true }, isCurrent);
  }

  /** Waits for the post-reconfiguration height map, anchor projection, and visible block geometry. */
  async whenPresentationSettled(timeoutMs: number, isCurrent: () => boolean = () => true): Promise<void> {
    if (this.destroyed || timeoutMs <= 0) return;
    const deadline = performance.now() + timeoutMs;
    let previousSignature: string | null = null;
    let stableFrames = 0;
    await new Promise<void>((resolve) => {
      const sample = () => {
        if (this.destroyed || !isCurrent() || performance.now() >= deadline) {
          resolve();
          return;
        }
        this.view.requestMeasure({
          read: () => {
            if (this.destroyed || !isCurrent()) return null;
            const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
            const visibleBlocks = Array.from(
              this.view.contentDOM.querySelectorAll<HTMLElement>('[data-meo-rendered-block-start-line]')
            ).filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom;
            }).map((element) => {
              const rect = element.getBoundingClientRect();
              return [
                element.dataset.meoRenderedBlockStartLine ?? '',
                Math.round(rect.top * 2) / 2,
                Math.round(rect.bottom * 2) / 2,
                Math.round(rect.width * 2) / 2
              ].join(':');
            });
            const visibleLine = Array.from(
              this.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')
            ).some((line) => {
              const rect = line.getBoundingClientRect();
              return rect.height > 0 && rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom;
            });
            const hasPendingPresentation = Array.from(
              this.view.contentDOM.querySelectorAll<HTMLElement>('[aria-busy="true"]')
            ).some((element) => {
              const rect = element.getBoundingClientRect();
              return rect.height > 0 && rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom;
            });
            return {
              hasVisibleContent: visibleLine || visibleBlocks.length > 0,
              hasPendingPresentation,
              signature: [
                Math.round(this.view.scrollDOM.scrollTop * 2) / 2,
                this.view.scrollDOM.scrollHeight,
                Math.round(this.view.contentHeight * 2) / 2,
                this.view.viewport.from,
                this.view.viewport.to,
                ...visibleBlocks
              ].join('|')
            };
          },
          write: (reading) => {
            if (this.destroyed || reading === null) {
              resolve();
              return;
            }
            const anchorBusy = this.hasActiveDocumentAnchorStabilization()
              || this.activeLayoutAnchor !== null
              || this.isActiveScrollTargetValid(this.activeScrollTarget);
            // The anchor stabilizer already observes layout across frames. Count
            // those same stable frames here, but never reveal until it has released
            // the anchor; a later geometry change still resets the count.
            stableFrames = reading.hasVisibleContent && reading.signature === previousSignature
              ? stableFrames + 1
              : 0;
            previousSignature = reading.signature;
            if ((stableFrames >= REQUIRED_STABLE_FRAMES && !anchorBusy && !reading.hasPendingPresentation)
              || performance.now() >= deadline) {
              resolve();
              return;
            }
            requestAnimationFrame(sample);
          }
        });
      };
      requestAnimationFrame(sample);
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.nativeInputViewport.release();
    this.activeNavigationReveals.clear();
    this.cancelElementRetention();
    this.modeTransitionChain = null;
    this.linkedPreviewEnabled = false;
    this.linkedViewportMap = null;
    if (this.linkedViewportMapRefreshTimer !== null) {
      clearTimeout(this.linkedViewportMapRefreshTimer);
      this.linkedViewportMapRefreshTimer = null;
    }
    this.linkedProjectionGeneration += 1;
    this.interactionGeneration += 1;
    this.navigationGeneration += 1;
    this.generation += 1;
    this.activeScrollTarget = null;
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = null;
    controllerByDom.delete(this.view.dom);
    if (this.interactionsAttached) {
      this.view.scrollDOM.removeEventListener('wheel', this.onWheel);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll, true);
      this.view.scrollDOM.removeEventListener('touchstart', this.onTouchStart);
      this.view.scrollDOM.removeEventListener('touchmove', this.onTouchMove);
      this.view.scrollDOM.removeEventListener('touchend', this.onTouchEnd);
      this.view.scrollDOM.removeEventListener('touchcancel', this.onTouchEnd);
      this.view.scrollDOM.removeEventListener('pointerdown', this.onPointerDown, true);
      this.view.scrollDOM.ownerDocument.removeEventListener('pointerup', this.onPointerUp, true);
      this.view.scrollDOM.ownerDocument.removeEventListener('pointercancel', this.onPointerUp, true);
      this.view.scrollDOM.ownerDocument.defaultView?.removeEventListener('blur', this.onWindowBlur);
      this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
      this.view.dom.removeEventListener('keyup', this.onKeyUp, true);
      this.view.dom.removeEventListener('beforeinput', this.onBeforeInput, true);
      this.view.dom.removeEventListener('input', this.onNativeInput);
      this.interactionsAttached = false;
    }
  }

  private stabilize(readTarget: () => ScrollTarget | null, options: StabilizeOptions = {}): void {
    if (this.destroyed || this.hasActiveScrollLock()) return;
    const generation = ++this.generation;
    const maxAttempts = Math.max(MAX_SETTLE_FRAMES, (options.requiredStableFrames ?? REQUIRED_STABLE_FRAMES) + 8);
    this.activeScrollTarget = null;
    this.activeLayoutAnchor = null;
    this.anchorStabilizationGeneration = generation;
    let attempts = 0;
    let stableFrames = 0;
    const finish = () => {
      if (this.anchorStabilizationGeneration === generation) {
        if (this.pendingDocumentPresentation?.generation === generation) this.pendingDocumentPresentation = null;
        this.anchorStabilizationGeneration = null;
      }
      if (options.onSettled) requestAnimationFrame(() => {
        if (!this.destroyed && generation === this.generation) options.onSettled?.();
      });
    };

    const measure = () => {
      if (
        this.destroyed || generation !== this.generation ||
        attempts >= maxAttempts
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
            // CodeMirror may redraw and correct its height map after the read
            // phase. Reconcile against that finished layout, not a target that
            // would move an already stable toolbar for one painted frame.
            const requested = readTarget();
            if (requested === null) {
              finish();
              return;
            }
            const currentTarget = this.resolveScrollTarget(requested, this.readScrollPosition());
            const changed = this.writeScrollPosition(currentTarget);
            stableFrames = changed ? 0 : stableFrames + 1;
            if (
              (stableFrames >= (options.requiredStableFrames ?? REQUIRED_STABLE_FRAMES)
                && (options.canSettle?.() ?? true)) ||
              attempts >= maxAttempts
            ) {
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
    if (options.settle) {
      // Late rendered-block measurements must follow the navigation target,
      // rather than reserve a nearby reading line and pull the target away.
      this.activeLayoutAnchor = null;
      this.activeNavigationReveals.add(state);
    }
    let attempts = 0;
    let stableFrames = 0;
    const isRevealCurrent = (): boolean => (
      !this.destroyed &&
      state.ownerGeneration === this.generation &&
      state.isCurrent()
    );
    const finish = (): void => {
      this.activeNavigationReveals.delete(state);
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
        write: (initialMeasurement) => {
          if (!isRevealCurrent() || initialMeasurement.kind === 'unavailable') {
            finish();
            return;
          }
          if (initialMeasurement.kind === 'stable') {
            if (state.phase === 'measured') finish();
            else completeFrame(measure, false);
            return;
          }
          // CodeMirror can redraw and re-anchor after the read phase. Adopt only
          // geometry measured after that batch, before the browser paints.
          queueMicrotask(() => {
            if (!isRevealCurrent()) {
              finish();
              return;
            }
            let measurement: NavigationRevealMeasurement;
            try {
              measurement = readMeasurement();
            } catch {
              finish();
              return;
            }
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
              this.activeScrollTarget = {
                changedSinceFrame: false,
                frameScheduled: false,
                generation: state.ownerGeneration,
                isCurrent: state.isCurrent,
                position: target,
                remainingFrames: MAX_SETTLE_FRAMES,
                stableFrames: 0
              };
              this.activeLayoutAnchor = null;
              this.anchorStabilizationGeneration = null;
              state.phase = 'adopted';
            }
            if (!isRevealCurrent()) {
              finish();
              return;
            }
            const activeTarget = this.activeScrollTarget;
            if (this.isActiveScrollTargetValid(activeTarget)) {
              activeTarget.position = target;
            }
            // A real caret reveal adopts a new Y for the native editing owner.
            const nativeOwner = this.nativeInputViewport.hasOwner();
            if (nativeOwner) this.nativeInputViewport.release();
            const changed = this.writeScrollPosition(target);
            if (nativeOwner) this.nativeInputViewport.capture(this.view.dom.ownerDocument.activeElement);
            if (this.isActiveScrollTargetValid(activeTarget)) {
              activeTarget.changedSinceFrame ||= changed;
              this.scheduleActiveScrollFrame();
            }
            state.phase = 'settling';
            completeFrame(measure, changed);
          });
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
      (activeTarget.isCurrent?.() ?? true) &&
      activeTarget.remainingFrames > 0
    ) return true;
    this.activeScrollTarget = null;
    return false;
  }

  private hasActiveDocumentAnchorStabilization(): boolean {
    return this.anchorStabilizationGeneration === this.generation;
  }

  private hasActiveNavigationReveal(): boolean {
    if (this.destroyed) return false;
    for (const state of this.activeNavigationReveals) {
      if (state.ownerGeneration === this.generation && state.isCurrent()) return true;
    }
    return false;
  }

  private hasActiveScrollLock(): boolean {
    return this.activeScrollLockGeneration !== null
      && this.activeScrollLockGeneration === this.scrollLockGeneration;
  }

  private handleWheel(event: WheelEvent): void {
    this.releaseLinkedPreviewAttention();
    if (this.getMode() !== 'live' || event.ctrlKey || (!event.deltaX && !event.deltaY)) {
      this.markInteraction();
      return;
    }
    this.markInteraction();
    this.lastWheelAt = performance.now();
    this.lastScrollDirection = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : this.lastScrollDirection;
    // Capture before the native wheel movement, but measure after its scroll event.
    const anchor = this.captureInteractionLayoutAnchor({ from: -1, to: -1 });
    if (anchor) this.activeLayoutAnchor = {
      ...anchor,
      frameScheduled: false,
      remainingFrames: MAX_SETTLE_FRAMES,
      revision: 0,
      stableFrames: 0
    };
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
      this.releaseLinkedPreviewAttention();
    }
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
    if (!isModifierKey && !isHistoryShortcut && this.nativeInputViewport.capture(event.target)) return;
    if (!this.canChangeLiveLayout(event)) return;
    // Native table inputs already retain/reveal their own caret during row
    // reflow. A second document anchor uses the outer editor's selection and
    // can scroll to a different row while the textarea still owns focus.
    if (event.target instanceof Element && event.target.matches('textarea')
      && event.target.closest('.meo-md-html-table-shell')) return;
    const insideRenderedBlock = event.target instanceof Element && Boolean(event.target.closest(
      '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
    ));
    const canRemoveBlockSyntax = event.key === 'Backspace' || event.key === 'Delete';
    if (!insideRenderedBlock && !canRemoveBlockSyntax) return;
    this.startInteractionLayoutStabilization(
      this.getInteractionLayoutRange(event.target, this.view.state.selection.main.head)
    );
  }

  private handlePotentialLayoutInteraction(event: PointerEvent): void {
    this.releaseLinkedPreviewAttention();
    this.markInteraction();
    if (event.button === 0 && event.target === this.view.scrollDOM) {
      this.scrollbarDragActive = true;
      const scroll = this.view.scrollDOM, rect = scroll.getBoundingClientRect();
      this.scrollbarDragStartY = event.clientX >= rect.left + scroll.clientLeft + scroll.clientWidth
        && event.clientX < rect.right && Number.isFinite(event.clientY) ? event.clientY : null;
      return;
    }
    if (this.getMode() !== 'live' || event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        '.meo-mermaid-editing-block, .meo-latex-math-editing-block, .meo-mermaid-toolbar, .meo-latex-math-toolbar, .meo-md-html-block, .meo-md-html-source-control, .meo-md-html-table-context-trigger, .meo-md-html-table-context-menu, .meo-md-html-table-column-resize-handle, .meo-md-code-block-start, .meo-md-code-block-end'
      )
    ) return;
    const pointerPosition = sourceLinePositionAtTarget(this.view, event.target) ??
      this.view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
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
    this.releaseLinkedPreviewAttention();
    const touch = event.touches[0];
    if (this.getMode() !== 'live' || !touch) {
      this.markInteraction();
      return;
    }
    this.markInteraction();
    this.lastTouchMoveAt = performance.now();
    this.lastTouchY = touch.clientY;
  }

  private handleTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (this.getMode() !== 'live' || !touch) {
      this.markInteraction();
      return;
    }
    const previousTouchY = this.lastTouchY;
    this.markInteraction();
    this.lastTouchMoveAt = performance.now();
    if (previousTouchY !== null) {
      const deltaY = previousTouchY - touch.clientY;
      this.lastScrollDirection = deltaY < 0 ? -1 : deltaY > 0 ? 1 : this.lastScrollDirection;
    }
    this.lastTouchY = touch.clientY;
  }

  private finishTouchGesture(): void {
    this.generation += 1;
    this.activeScrollTarget = null;
    this.lastTouchMoveAt = performance.now();
    this.lastTouchY = null;
  }

  /** Captures whether a later explicit navigation superseded transient layout ownership. */
  captureExplicitNavigationCurrentness(): () => boolean {
    const generation = this.explicitNavigationGeneration;
    return () => !this.destroyed && generation === this.explicitNavigationGeneration;
  }

  /** Allows deferred caret measurement to yield to newer commands, input, or scrolling. */
  captureNavigationCurrentness(): () => boolean {
    const generation = this.navigationGeneration;
    return () => !this.destroyed && generation === this.navigationGeneration;
  }

  /** Reserves currentness for one navigation intent without disturbing the active viewport owner. */
  beginNavigationReveal(): () => boolean {
    this.nativeInputViewport.release();
    this.modeTransitionChain = null;
    // An explicit newer navigation supersedes an absolute scroll lock left by
    // transient-edit settlement and any previous gesture's idle window.
    // Otherwise the old owner can pull the viewport back, or make the new
    // command look like it is still part of the earlier wheel gesture.
    this.scrollLockGeneration += 1;
    this.activeScrollLockGeneration = null;
    this.activeScrollLockCorrection = null;
    this.cancelElementRetention();
    this.explicitNavigationGeneration += 1;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.lastTouchMoveAt = Number.NEGATIVE_INFINITY;
    this.lastNativeScrollAt = Number.NEGATIVE_INFINITY;
    this.lastTouchY = null;
    const navigationGeneration = ++this.navigationGeneration;
    this.pendingNavigationTarget = null;
    return () => !this.destroyed && navigationGeneration === this.navigationGeneration;
  }

  /** Background viewport estimates cannot evict the current native edit. */
  hasNativeInputViewportOwner(): boolean { return this.nativeInputViewport.hasOwner(); }

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

  /** Retains a caret-like document position at its pre-layout viewport Y. */
  retainPositionTop(
    position: number,
    viewportTop: number,
    isCurrent: () => boolean = () => true
  ): void {
    const targetPosition = Math.max(0, Math.min(position, this.view.state.doc.length));
    this.runNavigationReveal(() => {
      const coords = this.view.coordsAtPos(targetPosition);
      if (!coords) return { kind: 'unavailable' };
      const delta = coords.top - viewportTop;
      if (Math.abs(delta) <= POSITION_EPSILON) return { kind: 'stable' };
      return {
        kind: 'target',
        target: { top: this.view.scrollDOM.scrollTop + delta }
      };
    }, { settle: true }, isCurrent);
  }

  private revealPositionInternal(
    position: number,
    {
      geometry = 'caret',
      marginMode = 'outside-only',
      originScrollTop,
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
      const coords = geometry === 'caret' ? this.view.coordsAtPos(targetPosition) : null;
      const scrollerRect = editorViewportBounds(this.view);
      const evaluationTop = Number.isFinite(originScrollTop)
        ? Math.max(0, originScrollTop as number)
        : current.top;
      if (y === 'center' || y === 'center-if-outside') {
        if (coords) {
          if (
            y === 'center-if-outside'
            && coords.top >= scrollerRect.top
            && coords.bottom <= scrollerRect.bottom
          ) {
            return { kind: 'stable' };
          }
          return {
            kind: 'target',
            target: {
              top: current.top + (coords.top + coords.bottom - scrollerRect.top - scrollerRect.bottom) / 2
            }
          };
        }
        const block = this.view.lineBlockAt(targetPosition);
        if (
          y === 'center-if-outside'
          && block.top >= current.top
          && block.bottom <= current.top + this.view.scrollDOM.clientHeight
        ) {
          return { kind: 'stable' };
        }
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
        const projectedTop = coords.top + current.top - evaluationTop;
        const projectedBottom = coords.bottom + current.top - evaluationTop;
        const targetHeight = Math.max(0, coords.bottom - coords.top);
        const viewportHeight = Math.max(0, scrollerRect.bottom - scrollerRect.top);
        const margin = Math.min(
          Math.max(0, yMargin),
          Math.max(0, (viewportHeight - targetHeight) / 2)
        );
        const appliedMargin = marginMode === 'comfort-band' ? margin : 0;
        if (
          projectedTop >= scrollerRect.top + appliedMargin &&
          projectedBottom <= scrollerRect.bottom - appliedMargin
        ) {
          return Math.abs(current.top - evaluationTop) <= POSITION_EPSILON
            ? { kind: 'stable' }
            : { kind: 'target', target: { top: evaluationTop } };
        }
        return {
          kind: 'target',
          target: {
            top: evaluationTop + (
              projectedTop < scrollerRect.top
                ? projectedTop - scrollerRect.top - margin
                : projectedBottom - scrollerRect.bottom + margin
            )
          }
        };
      }
      const block = this.view.lineBlockAt(targetPosition);
      const viewportHeight = this.view.scrollDOM.clientHeight;
      const margin = Math.min(
        Math.max(0, yMargin),
        Math.max(0, (viewportHeight - block.height) / 2)
      );
      const appliedMargin = marginMode === 'comfort-band' ? margin : 0;
      if (block.top < evaluationTop + appliedMargin) {
        return { kind: 'target', target: { top: block.top - margin } };
      }
      if (block.bottom > evaluationTop + viewportHeight - appliedMargin) {
        return { kind: 'target', target: { top: block.bottom - viewportHeight + margin } };
      }
      return Math.abs(current.top - evaluationTop) <= POSITION_EPSILON
        ? { kind: 'stable' }
        : { kind: 'target', target: { top: evaluationTop } };
    }, { schedule, settle }, isCurrent);
  }

  /** Capture background document presentation without superseding native reading. */
  captureDocumentPresentationAnchorToken(owner: ViewportAnchorOwner): ViewportAnchorToken | null {
    if (owner === 'editor' && this.isUserScrolling()) return null;
    const pending = this.pendingDocumentPresentation;
    const entryAnchor = owner === 'editor' && pending
      && this.hasActiveDocumentAnchorStabilization() && pending.generation === this.generation
      && this.isAnchorTokenCurrent(pending.record) && pending.document.deref() === this.view.state.doc
      ? pending.record.anchor : undefined;
    return this.captureAnchorToken(owner, entryAnchor);
  }

  captureAnchorToken(owner: ViewportAnchorOwner, entryAnchor?: ViewportDocumentAnchor): ViewportAnchorToken | null {
    if (this.destroyed) return null;
    const navigationAnchor = owner === 'editor'
      ? this.consumeVisibleNavigationTargetAnchor()
      : null;
    this.markInteraction(owner);
    const anchor = owner === 'editor'
      ? navigationAnchor ?? entryAnchor ?? this.captureDocumentAnchor()
      : this.capturePreviewDocumentAnchor();
    if (!anchor) return null;
    const handle = Object.freeze({}) as ViewportAnchorToken;
    this.anchorTokens.set(handle, {
      anchor,
      interactionGeneration: this.interactionGeneration,
      modeRoundTripSnapshot: null,
      projectedOwners: new Set()
    });
    return handle;
  }

  captureModeTransitionAnchorToken(owner: ViewportAnchorOwner): ViewportAnchorToken | null {
    if (this.destroyed) return null;
    // A mode switch is a programmatic viewport intent, not a user interaction
    // with either pane. Invalidate stale restorations without changing the
    // pane that should own the next split-to-single transition.
    this.invalidateViewportWork();
    const viewportOffset = this.view.scrollDOM.clientHeight / 3;
    const capturedAnchor = owner === 'editor'
      ? this.captureEditorReadingAnchor(viewportOffset)
      : this.capturePreviewDocumentAnchor(undefined, 1 / 3);
    if (!capturedAnchor) return null;
    const chain = this.modeTransitionChain ?? {
      anchor: capturedAnchor,
      editorAnchors: {}
    };
    this.modeTransitionChain = chain;
    // Source has line geometry only. Once Live exposes the corresponding
    // rendered block, promote that richer continuous range for subsequent
    // Preview projections without discarding Source's exact return snapshot.
    if (!chain.anchor.sourceRange && capturedAnchor.sourceRange) {
      chain.anchor = capturedAnchor;
    }
    if (owner === 'editor') {
      const editorMode = this.getMode();
      chain.editorAnchors[editorMode] ??= { ...capturedAnchor };
    }
    const handle = Object.freeze({}) as ViewportAnchorToken;
    const capturedScrollTop = owner === 'editor'
      ? this.view.scrollDOM.scrollTop
      : this.previewSurface?.readScrollTop?.() ?? null;
    this.anchorTokens.set(handle, {
      anchor: chain.anchor,
      interactionGeneration: this.interactionGeneration,
      modeRoundTripSnapshot: capturedScrollTop === null
        ? null
        : {
            editorMode: owner === 'editor' ? this.getMode() : null,
            owner,
            scrollTop: capturedScrollTop,
            returnEnabled: false,
            returned: false
          },
      projectedOwners: new Set()
    });
    return handle;
  }

  restoreAnchorToken(handle: ViewportAnchorToken, owner: ViewportAnchorOwner): void {
    this.runAnchorTransaction(handle, owner, () => undefined);
  }

  isTokenCurrent(handle: ViewportAnchorToken): boolean {
    const record = this.anchorTokens.get(handle);
    return Boolean(record && this.isAnchorTokenCurrent(record));
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
    const modeRoundTripReturn = Boolean(
      record && this.canRestoreModeRoundTripSnapshot(record, owner)
    );
    const currentTarget = Boolean(
      record &&
      targetAvailable &&
      this.isAnchorTokenCurrent(record) &&
      (!record.projectedOwners.has(owner) || modeRoundTripReturn)
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
        previousDocumentText: readDocumentTextProjection(this.view.state.doc),
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

  /** Background presentation inherits its outer scope or yields to native reading when standalone. */
  runDocumentPresentation(mutate: () => void): void {
    if (this.anchorTransactionScope.kind !== 'idle') {
      this.runDocumentChange(mutate);
      return;
    }
    const handle = this.captureDocumentPresentationAnchorToken('editor');
    this.runAnchorTransaction(handle, 'editor', () => this.runDocumentChange(mutate));
  }

  /** Uses the active scope, or captures the Editor surface for an explicit standalone Document change. */
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
      readDocumentTextProjection(this.view.state.doc)
    );
    if (!anchor) return;
    this.projectAnchorRecord(scope.record, scope.target, anchor);
    scope.record.anchor = anchor;
    if (scope.documentChangeObserved && scope.target === 'editor' && this.hasActiveDocumentAnchorStabilization()) {
      // A following ordered revision inherits the desired reading position,
      // rather than the intermediate viewport before the scheduled correction.
      this.pendingDocumentPresentation = {
        record: scope.record, document: new WeakRef(this.view.state.doc), generation: this.generation
      };
    }
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
    const roundTrip = record.modeRoundTripSnapshot;
    if (roundTrip && this.canRestoreModeRoundTripSnapshot(record, owner)) {
      if (owner === 'editor') {
        this.writeScrollPosition({
          top: roundTrip.scrollTop,
          left: this.view.scrollDOM.scrollLeft
        });
        this.stabilizeScrollPosition({
          top: roundTrip.scrollTop,
          left: this.view.scrollDOM.scrollLeft
        });
      } else {
        this.stabilizePreviewScrollTop(roundTrip.scrollTop, record);
      }
      roundTrip.returned = true;
      record.projectedOwners.add(owner);
      return;
    }
    const editorModeAnchor = owner === 'editor'
      ? this.modeTransitionChain?.editorAnchors[this.getMode()]
      : undefined;
    if (editorModeAnchor) {
      this.restoreDocumentAnchor({
        ...editorModeAnchor,
        lineOffset: editorModeAnchor.editorLineOffset ?? editorModeAnchor.lineOffset
      }, undefined, { force: true });
      record.projectedOwners.add(owner);
      return;
    }
    if (record.projectedOwners.has(owner)) return;
    if (owner === 'editor') {
      this.restoreDocumentAnchor({
        ...anchor,
        lineOffset: anchor.editorLineOffset ?? anchor.lineOffset
      }, undefined, { force: true });
      record.projectedOwners.add(owner);
      return;
    }
    const line = this.view.state.doc.lineAt(
      Math.min(Math.max(0, anchor.position), this.view.state.doc.length)
    );
    this.previewSurface?.restoreTopVisiblePosition({
      line: line.number,
      lineOffset: anchor.lineOffset,
      viewportOffset: anchor.viewportOffset,
      sourceRange: anchor.sourceRange
    }, () => this.isAnchorTokenCurrent(record));
    record.projectedOwners.add(owner);
  }

  private canRestoreModeRoundTripSnapshot(
    record: ViewportAnchorTokenRecord,
    owner: ViewportAnchorOwner
  ): boolean {
    const roundTrip = record.modeRoundTripSnapshot;
    return Boolean(
      roundTrip
      && roundTrip.returnEnabled
      && !roundTrip.returned
      && owner === roundTrip.owner
      && (owner !== 'editor' || roundTrip.editorMode === this.getMode())
    );
  }

  private stabilizePreviewScrollTop(
    targetScrollTop: number,
    record: ViewportAnchorTokenRecord
  ): void {
    if (!this.previewSurface?.readScrollTop || !this.previewSurface.writeScrollTop) return;
    let remainingFrames = MAX_SETTLE_FRAMES;
    const write = () => {
      if (this.destroyed || !this.isAnchorTokenCurrent(record)) return;
      const currentScrollTop = this.previewSurface?.readScrollTop?.();
      if (currentScrollTop === undefined) return;
      if (Math.abs(currentScrollTop - targetScrollTop) > POSITION_EPSILON) {
        this.previewSurface?.writeScrollTop?.(targetScrollTop);
      }
      remainingFrames -= 1;
      if (remainingFrames > 0) requestAnimationFrame(write);
    };
    write();
  }

  private mapAnchorThroughDocumentChange(
    anchor: ViewportDocumentAnchor,
    previousText: string,
    nextText: string
  ): ViewportDocumentAnchor | null {
    try {
      const change = findChangedDocumentRange(previousText, nextText);
      if (!change) return anchor;
      let sourceRange: ViewportDocumentAnchor['sourceRange'];
      if (anchor.sourceRange) {
        const from = positionAtDocumentLine(previousText, anchor.sourceRange.startLine);
        const to = positionAtDocumentLine(previousText, anchor.sourceRange.endLine + 1);
        if (change.previousTo <= from && change.from < from) {
          let lineDelta = 0;
          for (let index = 0; index < change.insertedText.length; index++) if (change.insertedText.charCodeAt(index) === 10) lineDelta++;
          for (let index = change.from; index < change.previousTo; index++) if (previousText.charCodeAt(index) === 10) lineDelta--;
          sourceRange = { ...anchor.sourceRange, startLine: anchor.sourceRange.startLine + lineDelta,
            endLine: anchor.sourceRange.endLine + lineDelta };
        } else if (change.from > to) sourceRange = anchor.sourceRange;
      }
      return {
        ...anchor,
        position: Math.min(
          Math.max(0, mapPositionThroughDocumentChange(anchor.position, previousText, nextText, change)),
          nextText.length
        ),
        // An edit inside the reading structure invalidates its fractional point.
        // Upstream edits retain that point with shifted source lines; Preview
        // uses it only if the new renderer still exposes that exact range.
        sourceRange
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
    const active = this.view.dom.ownerDocument.activeElement;
    const row = active instanceof HTMLTextAreaElement && this.view.contentDOM.contains(active)
      ? active.closest<HTMLTableRowElement>('tr[data-source-line-number]') : null;
    const rowRect = row?.getBoundingClientRect();
    const inputRect = row ? active!.getBoundingClientRect() : null;
    const rowLine = Number(row?.dataset.sourceLineNumber);
    const visibleRow = rowRect && inputRect && inputRect.top >= scrollerRect.top && inputRect.bottom <= scrollerRect.bottom
      && Number.isInteger(rowLine) && rowLine > 0 && rowLine <= this.view.state.doc.lines;
    const topBlock = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop);
    const bottomBlock = this.view.lineBlockAtHeight(
      this.view.scrollDOM.scrollTop + this.view.scrollDOM.clientHeight
    );
    return {
      scrollTop: this.view.scrollDOM.scrollTop,
      selection: {
        lineNumber: visibleRow ? rowLine : this.view.state.doc.lineAt(head).number,
        ...(visibleRow ? { viewportOffset: rowRect.top - scrollerRect.top } : {}),
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

  private finishScrollbarDrag(event?: PointerEvent): void {
    if (!this.scrollbarDragActive) return;
    const startY = this.scrollbarDragStartY;
    this.scrollbarDragStartY = null;
    this.scrollbarDragActive = false;
    this.markInteraction();
    if (startY === null || !event) return;
    const scroll = this.view.scrollDOM, rect = scroll.getBoundingClientRect();
    const top = rect.top + scroll.clientTop;
    const inset = Math.max(3, scroll.offsetWidth - scroll.clientWidth);
    // A track/arrow click is not a deliberate drag to an edge. A real thumb
    // release owns that edge even if deferred widget/height-map work has not
    // yet published the range Chromium used during the pointer gesture.
    this.nativeScrollbarBoundary = event.clientY < startY - 4 && event.clientY <= top + inset ? 'top'
      : event.clientY > startY + 4 && event.clientY >= top + scroll.clientHeight - inset ? 'bottom' : null;
    this.restoreNativeScrollbarBoundary();
  }

  private restoreNativeScrollbarBoundary(): boolean {
    if (!this.nativeScrollbarBoundary || this.scrollbarDragActive) return false;
    const scroll = this.view.scrollDOM;
    this.writeScrollPosition({ top: this.nativeScrollbarBoundary === 'top' ? 0
      : Math.max(0, scroll.scrollHeight - scroll.clientHeight), left: scroll.scrollLeft });
    return true;
  }

  private captureEditorReadingAnchor(viewportOffset: number): ViewportDocumentAnchor {
    const scroller = this.view.scrollDOM;
    const boundedViewportOffset = Math.max(0, Math.min(viewportOffset, scroller.clientHeight));
    const sampleHeight = scroller.scrollTop + boundedViewportOffset;
    if (this.getMode() === 'live') {
      const scrollerRect = scroller.getBoundingClientRect();
      const sampleY = scrollerRect.top + boundedViewportOffset;
      const renderedBlock = Array.from(
        this.view.contentDOM.querySelectorAll<HTMLElement>(
          '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
        )
      ).find((block) => {
        const rect = block.getBoundingClientRect();
        return rect.top <= sampleY && rect.bottom > sampleY;
      });
      if (renderedBlock) {
        const startLine = Number(renderedBlock.dataset.meoRenderedBlockStartLine);
        const endLine = Number(renderedBlock.dataset.meoRenderedBlockEndLine);
        if (Number.isInteger(startLine) && Number.isInteger(endLine) && endLine >= startLine) {
          const rect = renderedBlock.getBoundingClientRect();
          const progress = Math.max(0, Math.min(1, (sampleY - rect.top) / Math.max(1, rect.height)));
          const lineNumber = Math.round(startLine + (endLine - startLine) * progress);
          return {
            position: this.view.state.doc.line(Math.min(this.view.state.doc.lines, lineNumber)).from,
            lineOffset: 0,
            viewportOffset: boundedViewportOffset,
            sourceRange: {
              startLine,
              endLine,
              progress
            }
          };
        }
      }
    }
    const block = this.view.lineBlockAtHeight(sampleHeight);
    // A wrapped source line can cover thousands of visual rows. Its start is
    // not the text currently being read. Preserve the measured visual row's
    // source position; the normalized range also projects it into Preview.
    if (block.height > this.view.defaultLineHeight * 1.5
      && typeof this.view.posAtCoords === 'function') {
      const bounds = scroller.getBoundingClientRect(), content = this.view.contentDOM.getBoundingClientRect();
      const gutter = scroller.querySelector('.cm-gutters')?.getBoundingClientRect();
      const position = this.view.posAtCoords({ x: Math.min(bounds.right - 2,
        Math.max(bounds.left + 2, content.left + 2, (gutter?.right ?? bounds.left) + 2)),
        y: bounds.top + boundedViewportOffset });
      const coords = position === null ? null : this.view.coordsAtPos(position);
      if (position !== null && coords && position >= block.from && position <= block.to) {
        const line = this.view.state.doc.lineAt(position).number;
        return { position, lineOffset: 0, preciseTextPosition: true, viewportOffset: Math.max(0, coords.top - bounds.top),
          sourceRange: { startLine: line, endLine: line,
            progress: Math.max(0, Math.min(1,
              (scroller.scrollTop + coords.top - bounds.top - block.top) / block.height)) } };
      }
    }
    return {
      position: block.from,
      lineOffset: 0,
      viewportOffset: Math.max(0, block.top - scroller.scrollTop)
    };
  }

  private capturePreviewDocumentAnchor(
    viewportOffset = 0,
    viewportRatio?: number,
    sourceText?: string
  ): (ViewportDocumentAnchor & { interpolatedWhitespace?: boolean }) | null {
    const position = viewportRatio === undefined
      ? this.previewSurface?.captureTopVisiblePosition(viewportOffset)
      : this.previewSurface?.captureReadingPosition?.(viewportRatio)
        ?? this.previewSurface?.captureTopVisiblePosition(viewportOffset);
    if (!position) return null;
    const requestedLine = Math.max(
      1,
      Math.floor(Number.isFinite(position.line) ? position.line : 1)
    );
    const lineNumber = Math.min(requestedLine, this.view.state.doc.lines);
    return {
      position: sourceText === undefined
        ? this.view.state.doc.line(lineNumber).from
        : positionAtDocumentLine(sourceText, requestedLine),
      lineOffset: Number.isFinite(position.lineOffset) ? Math.max(0, position.lineOffset) : 0,
      editorLineOffset: position.editorLineOffset !== undefined && Number.isFinite(position.editorLineOffset)
        ? Math.max(0, position.editorLineOffset)
        : undefined,
      viewportOffset: position.viewportOffset !== undefined && Number.isFinite(position.viewportOffset)
        ? Math.max(0, position.viewportOffset)
        : undefined,
      interpolatedWhitespace: position.interpolatedWhitespace,
      sourceRange: position.sourceRange
        ? {
            startLine: Math.min(
              Math.max(1, Math.floor(position.sourceRange.startLine)),
              this.view.state.doc.lines
            ),
            endLine: Math.min(
              Math.max(1, Math.floor(position.sourceRange.endLine)),
              this.view.state.doc.lines
            ),
            progress: Math.max(0, Math.min(1, position.sourceRange.progress))
          }
        : undefined
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
    // At the document boundary, preserving a later reading line would turn
    // passive block growth into a scroll that hides the first content.
    if (this.view.scrollDOM.scrollTop <= POSITION_EPSILON) {
      return {
        position: 0,
        viewportOffset: this.view.lineBlockAt(0).top - this.view.scrollDOM.scrollTop
      };
    }

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
    const candidates = Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-line'))
      .map((line) => ({
        position: this.view.posAtDOM(line),
        top: line.getBoundingClientRect().top
      }))
      .filter((candidate) => (
        (candidate.position < changedRange.from || candidate.position > changedRange.to) &&
        candidate.top >= scrollerRect.top && candidate.top < scrollerRect.bottom
      ));
    if (candidates.length === 0) {
      // A tall table or diagram can occupy the entire viewport. Its rendered
      // geometry remains a reading witness even when no text line is mounted.
      const seenPositions = new Set<number>();
      for (const element of this.view.contentDOM.querySelectorAll<HTMLElement>(
        '.meo-md-html-table-wrap tr[data-source-line-number], [data-meo-rendered-block-kind][data-meo-rendered-block-start-line]'
      )) {
        const position = this.readingBlockPosition(element);
        if (position === null || seenPositions.has(position)
          || (position >= changedRange.from && position <= changedRange.to)) continue;
        // Mode shells and their nested previews can describe the same source
        // position. Retention must read back the same outer geometry we capture.
        seenPositions.add(position);
        const rect = element.getBoundingClientRect();
        if (rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom) {
          candidates.push({ position, top: rect.top });
        }
      }
    }
    if (candidates.length === 0) return null;

    const readingY = scrollerRect.top + scrollerRect.height * 0.25;
    const anchor = candidates.reduce((closest, candidate) => (
      Math.abs(candidate.top - readingY) < Math.abs(closest.top - readingY) ? candidate : closest
    ));
    return {
      position: anchor.position,
      viewportOffset: this.view.lineBlockAt(anchor.position).top - this.view.scrollDOM.scrollTop,
      visualViewportOffset: this.isUserScrolling() ? undefined : anchor.top - scrollerRect.top,
      readingDocumentTop: this.isUserScrolling()
        ? anchor.top + this.view.scrollDOM.scrollTop - scrollerRect.top
        : undefined,
      readingScrollTop: this.isUserScrolling() ? this.view.scrollDOM.scrollTop : undefined,
      readingHeightMapTop: this.isUserScrolling() ? this.view.lineBlockAt(anchor.position).top : undefined,
      readingNativeAdopted: this.isUserScrolling() ? false : undefined
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
          ...this.resolveLayoutAnchorTarget(current)
        };
      },
      write: (measurement) => {
        activeAnchor.frameScheduled = false;
        if (!measurement || this.activeLayoutAnchor !== activeAnchor) return;
        queueMicrotask(() => {
          if (this.activeLayoutAnchor !== activeAnchor) return;
          const resolved = activeAnchor.readingDocumentTop === undefined && measurement.revision === activeAnchor.revision
            ? measurement
            : this.resolveLayoutAnchorTarget(activeAnchor);
          // Virtual height corrections may arrive after two stable frames while
          // the wheel gesture is still active. Settle within the existing frame
          // budget once it goes idle; never retain an anchor across new input.
          const userScrolling = this.isUserScrolling();
          if (!userScrolling) activeAnchor.remainingFrames -= 1;
          const changed = this.writeScrollPosition(resolved.target);
          if (resolved.readingDocumentTop !== undefined) {
            this.adoptReadingLayout(activeAnchor, resolved.readingDocumentTop);
          }
          activeAnchor.stableFrames = changed ? 0 : activeAnchor.stableFrames + 1;
          if (!userScrolling && (
            activeAnchor.stableFrames >= REQUIRED_STABLE_FRAMES ||
            activeAnchor.remainingFrames <= 0
          )) {
            // Stop polling, but keep a proven reading anchor for deferred widget
            // measurements. The next user intent retires it via markInteraction.
            if (activeAnchor.readingNativeAdopted) activeAnchor.remainingFrames = 0;
            else this.activeLayoutAnchor = null;
            return;
          }
          requestAnimationFrame(() => this.scheduleLayoutMeasure());
        });
      }
    });
  }

  private adoptReadingLayout(anchor: ActiveLayoutAnchor, documentTop: number): void {
    anchor.readingDocumentTop = documentTop;
    anchor.readingScrollTop = this.view.scrollDOM.scrollTop;
    anchor.readingHeightMapTop = this.view.lineBlockAt(anchor.position).top;
  }

  private readingLayoutUnchanged(anchor: ActiveLayoutAnchor): boolean {
    const heightMapTop = this.view.lineBlockAt(anchor.position).top;
    // Height-map movement is a layout signal, never an assumed applied scroll distance.
    // A changing scroll range alone cannot distinguish native motion from boundary following.
    return Math.abs(heightMapTop - (anchor.readingHeightMapTop ?? heightMapTop)) <= POSITION_EPSILON;
  }

  private readLayoutAnchorDocumentTop(position: number): number | null {
    // Caret rectangles can move inside a stable line when fonts or tokens change.
    // Only the outer line box represents movement of the reading content.
    const line = Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-line'))
      .find((element) => this.view.posAtDOM(element) === position)
      ?? Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>(
        '.meo-md-html-table-wrap tr[data-source-line-number], [data-meo-rendered-block-kind][data-meo-rendered-block-start-line]'
      )).find((element) => this.readingBlockPosition(element) === position);
    return line
      ? line.getBoundingClientRect().top + this.view.scrollDOM.scrollTop
        - this.view.scrollDOM.getBoundingClientRect().top
      : null;
  }

  private readingBlockPosition(element: HTMLElement): number | null {
    const line = Number(element.dataset?.sourceLineNumber ?? element.dataset?.meoRenderedBlockStartLine);
    const doc = this.view.state?.doc;
    return doc && Number.isSafeInteger(line) && line > 0 && line <= doc.lines
      ? doc.line(line).from : null;
  }

  private resolveLayoutAnchorTarget(anchor: ActiveLayoutAnchor): {
    target: ScrollPosition;
    readingDocumentTop?: number;
  } {
    const current = this.readScrollPosition();
    if (anchor.readingDocumentTop !== undefined) {
      const readingDocumentTop = this.readLayoutAnchorDocumentTop(anchor.position);
      if (readingDocumentTop === null) return { target: current };
      // Preserve the offset last adopted from real native scrolling. CodeMirror's
      // nominal height delta may differ from its applied correction or a browser clamp.
      const geometryDelta = readingDocumentTop - anchor.readingDocumentTop;
      const layoutUnchanged = Math.abs(geometryDelta) <= POSITION_EPSILON && this.readingLayoutUnchanged(anchor);
      return {
        target: this.resolveScrollTarget({
          // A receipt without a native scroll record cannot establish an applied movement.
          top: !anchor.readingNativeAdopted || layoutUnchanged
            ? current.top : (anchor.readingScrollTop ?? current.top) + geometryDelta
        }, current),
        readingDocumentTop
      };
    }
    if (anchor.visualViewportOffset !== undefined) {
      const documentTop = this.readLayoutAnchorDocumentTop(anchor.position);
      return { target: documentTop === null ? current : this.resolveScrollTarget({
        top: documentTop - anchor.visualViewportOffset
      }, current) };
    }
    return { target: this.resolveScrollTarget({
      top: this.view.lineBlockAt(anchor.position).top - anchor.viewportOffset
    }, current) };
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
    // Background anchors and linked projection share this write boundary. A
    // live native edit keeps priority until actual navigation releases it.
    const nativeTop = this.nativeInputViewport.scrollTop(), top = nativeTop ?? target.top;
    const current = this.readScrollPosition();
    const topChanged = Math.abs(current.top - top) > POSITION_EPSILON;
    const leftChanged = Math.abs(current.left - target.left) > POSITION_EPSILON;
    if (topChanged) this.view.scrollDOM.scrollTop = top;
    if (leftChanged) this.view.scrollDOM.scrollLeft = target.left;
    const rounded = nativeTop !== null && this.nativeInputViewport.absorbScrollRounding(top);
    return topChanged || leftChanged || rounded;
  }

  isScrollbarDragging(): boolean {
    return this.scrollbarDragActive;
  }

  /** Includes native momentum so background rendering can wait beyond the last wheel event. */
  isUserScrolling(): boolean {
    return this.scrollbarDragActive ||
      performance.now() - Math.max(this.lastWheelAt, this.lastTouchMoveAt, this.lastNativeScrollAt) <= WHEEL_GESTURE_IDLE_MS;
  }
}
