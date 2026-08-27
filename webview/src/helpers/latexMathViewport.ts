import { createElement, RotateCcw, ZoomIn, ZoomOut } from 'lucide';
import { getUiStrings, type UiLanguage } from '../../../src/foundation/uiLanguage';

export type LatexMathViewportController = {
  destroy(): void;
};

type LatexMathBlockViewportOptions = {
  interactive?: boolean;
  uiLanguage?: UiLanguage;
};

type LatexMathInlineViewportOptions = {
  layout: { kind: 'inline' };
};

type LatexMathViewportOptions = LatexMathBlockViewportOptions | LatexMathInlineViewportOptions;

type LatexMathViewportLayout =
  | { kind: 'block'; interactive: boolean }
  | { kind: 'inline' };

type LatexMathViewportPhase = 'observing-native' | 'fitted';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;
const HORIZONTAL_PADDING = 16;
const MIN_PREVIEW_HEIGHT = 24;
const AXIS_EPSILON = 0.000001;

type LatexMathPresentationSnapshot = {
  fontSize: string;
  zoom: string;
  height: string;
};

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function hasOnlyPositiveAxisAlignedTransforms(root: HTMLElement, ownerWindow: Window): boolean {
  for (let current: HTMLElement | null = root; current; current = current.parentElement) {
    const transform = ownerWindow.getComputedStyle(current).transform;
    if (!transform || transform === 'none') {
      continue;
    }
    try {
      const matrix = new DOMMatrixReadOnly(transform);
      if (
        !matrix.is2D ||
        ![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite) ||
        matrix.a <= 0 ||
        matrix.d <= 0 ||
        Math.abs(matrix.b) > AXIS_EPSILON ||
        Math.abs(matrix.c) > AXIS_EPSILON
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function hasInlineContentOverflow(root: HTMLElement, ownerWindow: Window): boolean {
  const rootRect = root.getBoundingClientRect();
  const rootStyle = ownerWindow.getComputedStyle(root);
  const paddingLeft = Number.parseFloat(rootStyle.paddingLeft);
  const paddingRight = Number.parseFloat(rootStyle.paddingRight);
  const leftBoundary = rootRect.left + paddingLeft;
  const rightBoundary = rootRect.right - paddingRight;
  const baseRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
    .map((base) => base.getBoundingClientRect());
  if (
    baseRects.length === 0 ||
    ![paddingLeft, paddingRight, leftBoundary, rightBoundary].every(Number.isFinite) ||
    paddingLeft < 0 ||
    paddingRight < 0 ||
    !baseRects.every((rect) => [rect.left, rect.right].every(Number.isFinite))
  ) {
    return false;
  }
  return Math.min(...baseRects.map((rect) => rect.left)) < leftBoundary - 1
    || Math.max(...baseRects.map((rect) => rect.right)) > rightBoundary + 1;
}

function createControlButton(
  ownerDocument: Document,
  icon: typeof ZoomIn,
  label: string,
  onActivate: () => void
): HTMLButtonElement {
  const button = ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'meo-visual-control-btn meo-latex-math-zoom-btn';
  button.appendChild(createElement(icon, { width: 16, height: 16 }));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  return button;
}

export function attachLatexMathViewport(
  root: HTMLElement,
  options: LatexMathViewportOptions = {}
): LatexMathViewportController {
  const layout: LatexMathViewportLayout = 'layout' in options
    ? options.layout
    : { kind: 'block', interactive: options.interactive ?? false };
  const interactive = layout.kind === 'block' && layout.interactive;
  const uiLanguage = 'uiLanguage' in options ? options.uiLanguage ?? 'en' : 'en';
  const strings = getUiStrings(uiLanguage);
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  let canvas: HTMLElement | null = null;
  let phase: LatexMathViewportPhase = layout.kind === 'inline' ? 'observing-native' : 'fitted';

  let fitScale = 1;
  let userZoom = 1;
  let renderedScale = 1;
  let naturalWidth = 0;
  let measureFrame = 0;
  let destroyed = false;

  let resizeObserver: ResizeObserver | null = null;
  let observedMeasurementRoot: HTMLElement | null = null;

  const attachCanvas = (): HTMLElement => {
    if (canvas) return canvas;
    canvas = ownerDocument.createElement('div');
    canvas.className = 'meo-latex-math-canvas';
    while (root.firstChild) {
      canvas.appendChild(root.firstChild);
    }
    root.appendChild(canvas);
    root.classList.add('meo-latex-math-viewport');
    root.classList.toggle('is-interactive', interactive);
    resizeObserver?.observe(canvas);
    return canvas;
  };

  const restoreNativeInline = (): void => {
    if (!canvas || layout.kind !== 'inline') return;
    resizeObserver?.unobserve(canvas);
    while (canvas.firstChild) {
      root.insertBefore(canvas.firstChild, canvas);
    }
    canvas.remove();
    canvas = null;
    root.classList.remove('meo-latex-math-viewport', 'is-interactive');
    phase = 'observing-native';
  };

  if (layout.kind === 'block') {
    attachCanvas();
  }

  const capturePresentation = (): LatexMathPresentationSnapshot => ({
    fontSize: canvas?.style.fontSize ?? '',
    zoom: canvas?.style.zoom ?? '',
    height: root.style.height
  });

  const restorePresentation = (snapshot: LatexMathPresentationSnapshot): void => {
    if (canvas) {
      canvas.style.fontSize = snapshot.fontSize;
      canvas.style.zoom = snapshot.zoom;
    }
    root.style.height = snapshot.height;
  };

  const commitPresentation = (
    candidateNaturalWidth: number,
    candidateFitScale: number,
    entryPresentation = capturePresentation()
  ): boolean => {
    if (!canvas) return false;
    const candidateRenderedScale = candidateFitScale * userZoom;
    if (
      !isFinitePositive(candidateNaturalWidth) ||
      !isFinitePositive(candidateFitScale) ||
      !isFinitePositive(candidateRenderedScale)
    ) {
      restorePresentation(entryPresentation);
      return false;
    }

    try {
      canvas.style.zoom = '1';
      canvas.style.fontSize = `${candidateRenderedScale}em`;

      // Chromium enforces a minimum rendered font size in some hosts. Font-size
      // scaling remains sharp above that floor; zoom only supplies the residual
      // scale needed below it so an unusually wide formula still fits.
      const uncorrectedWidth = canvas.getBoundingClientRect().width;
      const targetWidth = candidateNaturalWidth * candidateRenderedScale;
      if (!isFinitePositive(uncorrectedWidth) || !isFinitePositive(targetWidth)) {
        restorePresentation(entryPresentation);
        return false;
      }
      const residualScale = Math.min(1, targetWidth / uncorrectedWidth);
      if (!isFinitePositive(residualScale)) {
        restorePresentation(entryPresentation);
        return false;
      }
      canvas.style.zoom = `${residualScale}`;

      let candidateHeight: string | null = null;
      if (layout.kind === 'block' && !interactive) {
        const renderedHeight = canvas.getBoundingClientRect().height;
        if (!isFinitePositive(renderedHeight)) {
          restorePresentation(entryPresentation);
          return false;
        }
        candidateHeight = `${Math.max(MIN_PREVIEW_HEIGHT, Math.ceil(renderedHeight))}px`;
      }

      if (candidateHeight !== null) {
        root.style.height = candidateHeight;
      }
      naturalWidth = candidateNaturalWidth;
      fitScale = candidateFitScale;
      renderedScale = candidateRenderedScale;
      return true;
    } catch {
      restorePresentation(entryPresentation);
      return false;
    }
  };

  const applyTransform = () => {
    const entryPresentation = capturePresentation();
    commitPresentation(naturalWidth, fitScale, entryPresentation);
  };

  const reset = () => {
    userZoom = 1;
    applyTransform();
  };

  const measure = () => {
    measureFrame = 0;
    if (destroyed || !root.isConnected) {
      return;
    }
    const measurementRoot = layout.kind === 'inline' ? root.parentElement : root;
    if (resizeObserver && measurementRoot !== observedMeasurementRoot) {
      if (observedMeasurementRoot && observedMeasurementRoot !== root) {
        resizeObserver.unobserve(observedMeasurementRoot);
      }
      observedMeasurementRoot = measurementRoot;
      if (observedMeasurementRoot && observedMeasurementRoot !== root) {
        resizeObserver.observe(observedMeasurementRoot);
      }
    }
    let transitionedFromNative = false;
    if (layout.kind === 'inline' && phase === 'observing-native') {
      if (!hasInlineContentOverflow(root, ownerWindow)) return;
      attachCanvas();
      phase = 'fitted';
      transitionedFromNative = true;
    }
    if (!canvas) return;
    const entryPresentation = capturePresentation();
    let committed = false;
    try {
      let effectiveScale = 1;
      let availableWidth = root.clientWidth - HORIZONTAL_PADDING;
      if (!interactive) {
        if (!measurementRoot) {
          restorePresentation(entryPresentation);
          if (transitionedFromNative) restoreNativeInline();
          return;
        }
        const rootStyle = ownerWindow.getComputedStyle(measurementRoot);
        const paddingLeft = Number.parseFloat(rootStyle.paddingLeft);
        const paddingRight = Number.parseFloat(rootStyle.paddingRight);
        const rootRectWidth = measurementRoot.getBoundingClientRect().width;
        const offsetWidth = measurementRoot.offsetWidth;
        availableWidth = measurementRoot.clientWidth - paddingLeft - paddingRight;
        if (
          !hasOnlyPositiveAxisAlignedTransforms(measurementRoot, ownerWindow) ||
          !Number.isFinite(paddingLeft) || paddingLeft < 0 ||
          !Number.isFinite(paddingRight) || paddingRight < 0 ||
          !isFinitePositive(rootRectWidth) ||
          !isFinitePositive(offsetWidth)
        ) {
          restorePresentation(entryPresentation);
          if (transitionedFromNative) restoreNativeInline();
          return;
        }
        effectiveScale = rootRectWidth / offsetWidth;
      }
      if (!isFinitePositive(effectiveScale) || !isFinitePositive(availableWidth)) {
        restorePresentation(entryPresentation);
        if (transitionedFromNative) restoreNativeInline();
        return;
      }
      availableWidth *= effectiveScale;
      if (!isFinitePositive(availableWidth)) {
        restorePresentation(entryPresentation);
        if (transitionedFromNative) restoreNativeInline();
        return;
      }

      canvas.style.zoom = '1';
      canvas.style.fontSize = '1em';
      const naturalRectWidth = canvas.getBoundingClientRect().width;
      const fallbackNaturalWidth = canvas.scrollWidth * effectiveScale;
      const measuredNaturalWidth = isFinitePositive(naturalRectWidth)
        ? naturalRectWidth
        : fallbackNaturalWidth;
      if (!isFinitePositive(measuredNaturalWidth)) {
        restorePresentation(entryPresentation);
        if (transitionedFromNative) restoreNativeInline();
        return;
      }
      const candidateFitScale = Math.min(1, availableWidth / measuredNaturalWidth);
      if (!isFinitePositive(candidateFitScale)) {
        restorePresentation(entryPresentation);
        if (transitionedFromNative) restoreNativeInline();
        return;
      }

      committed = commitPresentation(measuredNaturalWidth, candidateFitScale, entryPresentation);
    } catch {
      restorePresentation(entryPresentation);
    }
    if (transitionedFromNative && !committed) restoreNativeInline();
  };

  const scheduleMeasure = () => {
    if (destroyed || measureFrame !== 0) {
      return;
    }
    measureFrame = ownerWindow.requestAnimationFrame(measure);
  };

  if (typeof ownerWindow.ResizeObserver !== 'undefined') {
    resizeObserver = new ownerWindow.ResizeObserver(scheduleMeasure);
    resizeObserver.observe(root);
    if (canvas) resizeObserver.observe(canvas);
  } else {
    ownerWindow.addEventListener('resize', scheduleMeasure);
  }

  let controls: HTMLElement | null = null;
  if (interactive) {
    controls = ownerDocument.createElement('div');
    controls.className = 'meo-visual-controls meo-latex-math-zoom-controls';
    controls.append(
      createControlButton(ownerDocument, ZoomIn, strings.zoomIn, () => {
        userZoom = Math.min(MAX_ZOOM, userZoom + ZOOM_STEP);
        applyTransform();
      }),
      createControlButton(ownerDocument, ZoomOut, strings.zoomOut, () => {
        userZoom = Math.max(MIN_ZOOM, userZoom - ZOOM_STEP);
        applyTransform();
      }),
      createControlButton(ownerDocument, RotateCcw, strings.resetZoom, reset)
    );
    root.appendChild(controls);
  }

  scheduleMeasure();
  ownerDocument.fonts?.addEventListener('loadingdone', scheduleMeasure);
  void ownerDocument.fonts?.ready.then(scheduleMeasure);

  return {
    destroy() {
      destroyed = true;
      if (measureFrame !== 0) {
        ownerWindow.cancelAnimationFrame(measureFrame);
      }
      resizeObserver?.disconnect();
      if (!resizeObserver) {
        ownerWindow.removeEventListener('resize', scheduleMeasure);
      }
      ownerDocument.fonts?.removeEventListener('loadingdone', scheduleMeasure);
      controls?.remove();
    }
  };
}
