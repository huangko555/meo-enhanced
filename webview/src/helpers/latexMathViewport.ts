import { createElement, RotateCcw, ZoomIn, ZoomOut } from 'lucide';

export type LatexMathViewportController = {
  destroy(): void;
};

type LatexMathViewportOptions = {
  interactive?: boolean;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;
const HORIZONTAL_PADDING = 16;
const MIN_PREVIEW_HEIGHT = 24;

function createControlButton(
  ownerDocument: Document,
  icon: typeof ZoomIn,
  label: string,
  onActivate: () => void
): HTMLButtonElement {
  const button = ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'meo-latex-math-zoom-btn';
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
  { interactive = false }: LatexMathViewportOptions = {}
): LatexMathViewportController {
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const canvas = ownerDocument.createElement('div');
  canvas.className = 'meo-latex-math-canvas';
  while (root.firstChild) {
    canvas.appendChild(root.firstChild);
  }
  root.appendChild(canvas);
  root.classList.add('meo-latex-math-viewport');
  root.classList.toggle('is-interactive', interactive);

  let fitScale = 1;
  let userZoom = 1;
  let panX = 0;
  let panY = 0;
  let renderedScale = 1;
  let naturalWidth = 0;
  let dragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let measureFrame = 0;
  let destroyed = false;

  const applyTransform = () => {
    renderedScale = fitScale * userZoom;
    canvas.style.zoom = '1';
    canvas.style.fontSize = `${renderedScale}em`;
    canvas.style.left = `${panX}px`;
    canvas.style.top = `${panY}px`;

    // Chromium enforces a minimum rendered font size in some hosts. Font-size
    // scaling remains sharp above that floor; zoom only supplies the residual
    // scale needed below it so an unusually wide formula still fits.
    const uncorrectedWidth = canvas.getBoundingClientRect().width;
    const targetWidth = naturalWidth * renderedScale;
    const residualScale = uncorrectedWidth > 0
      ? Math.min(1, targetWidth / uncorrectedWidth)
      : 1;
    canvas.style.zoom = `${residualScale}`;

    if (!interactive) {
      root.style.height = `${Math.max(MIN_PREVIEW_HEIGHT, Math.ceil(canvas.getBoundingClientRect().height))}px`;
    }
  };

  const reset = () => {
    userZoom = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  };

  const measure = () => {
    measureFrame = 0;
    if (destroyed || !root.isConnected) {
      return;
    }
    canvas.style.zoom = '1';
    canvas.style.fontSize = '1em';
    const naturalRect = canvas.getBoundingClientRect();
    naturalWidth = naturalRect.width || canvas.scrollWidth;
    const availableWidth = Math.max(0, root.clientWidth - HORIZONTAL_PADDING);
    fitScale = naturalWidth > 0 && availableWidth > 0
      ? Math.min(1, availableWidth / naturalWidth)
      : 1;
    applyTransform();
  };

  const scheduleMeasure = () => {
    if (destroyed || measureFrame !== 0) {
      return;
    }
    measureFrame = ownerWindow.requestAnimationFrame(measure);
  };

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ownerWindow.ResizeObserver !== 'undefined') {
    resizeObserver = new ownerWindow.ResizeObserver(scheduleMeasure);
    resizeObserver.observe(root);
    resizeObserver.observe(canvas);
  } else {
    ownerWindow.addEventListener('resize', scheduleMeasure);
  }

  let controls: HTMLElement | null = null;
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) {
      return;
    }
    panX += event.clientX - lastPointerX;
    panY += event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    applyTransform();
  };
  const onPointerUp = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    root.classList.remove('is-dragging');
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!interactive || event.button !== 0 || (event.target as Element | null)?.closest('.meo-latex-math-zoom-controls')) {
      return;
    }
    event.preventDefault();
    dragging = true;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    root.classList.add('is-dragging');
  };

  if (interactive) {
    controls = ownerDocument.createElement('div');
    controls.className = 'meo-latex-math-zoom-controls';
    controls.append(
      createControlButton(ownerDocument, ZoomIn, 'Zoom in', () => {
        userZoom = Math.min(MAX_ZOOM, userZoom + ZOOM_STEP);
        applyTransform();
      }),
      createControlButton(ownerDocument, ZoomOut, 'Zoom out', () => {
        userZoom = Math.max(MIN_ZOOM, userZoom - ZOOM_STEP);
        applyTransform();
      }),
      createControlButton(ownerDocument, RotateCcw, 'Reset zoom', reset)
    );
    root.appendChild(controls);
    root.addEventListener('pointerdown', onPointerDown);
    ownerDocument.addEventListener('pointermove', onPointerMove);
    ownerDocument.addEventListener('pointerup', onPointerUp);
    ownerDocument.addEventListener('pointercancel', onPointerUp);
  }

  scheduleMeasure();
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
      root.removeEventListener('pointerdown', onPointerDown);
      ownerDocument.removeEventListener('pointermove', onPointerMove);
      ownerDocument.removeEventListener('pointerup', onPointerUp);
      ownerDocument.removeEventListener('pointercancel', onPointerUp);
      controls?.remove();
    }
  };
}
