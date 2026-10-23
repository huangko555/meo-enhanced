import { createElement, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { suppressRenderedBlockPointerFocus } from './renderedBlockActionFocus';
import { stepVisualZoom } from './visualZoom';

export type MermaidFullscreenExitCause =
  | 'user-close' | 'escape' | 'dispose' | 'replacement' | 'mode' | 'external' | 'theme';

export type MermaidFullscreenViewer = {
  update(svg: string): void;
  refreshTheme(): void;
  close(cause: MermaidFullscreenExitCause): void;
};

let activeViewer: MermaidFullscreenViewer | null = null;

/** Both reading surfaces use the outer Webview modal; its camera never mutates the source block. */
export function openMermaidFullscreen(options: {
  svg: string;
  uiLanguage: UiLanguage;
  pointerDriven?: boolean;
  decorate?: (element: HTMLElement) => void;
  onClose: (cause: MermaidFullscreenExitCause, pointerDriven: boolean) => void;
}): MermaidFullscreenViewer {
  activeViewer?.close('replacement');
  const strings = getUiStrings(options.uiLanguage);
  const overlay = document.createElement('div');
  overlay.className = 'meo-mermaid-fullscreen-scrim';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', strings.fullscreen);
  overlay.tabIndex = -1;
  const container = document.createElement('div');
  container.className = 'meo-mermaid-fullscreen';
  const svgWrapper = document.createElement('div');
  svgWrapper.className = 'meo-mermaid-svg-wrapper';
  svgWrapper.innerHTML = options.svg;
  const controls = document.createElement('div');
  controls.className = 'meo-visual-controls meo-mermaid-zoom-controls meo-mermaid-fullscreen-controls';
  let zoom = 1, panX = 0, panY = 0, baseScale = 1;
  let pointerId: number | null = null;
  let lastX = 0, lastY = 0;
  let closed = false;
  let pointerDriven = options.pointerDriven ?? false;
  const events = new AbortController();

  const applyTransform = () => {
    if (closed) return;
    const scale = baseScale * zoom;
    svgWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    const svg = svgWrapper.querySelector('svg');
    if (!svg) return;
    const viewport = container.getBoundingClientRect();
    const diagram = svg.getBoundingClientRect();
    const correction = (start: number, end: number, low: number, high: number) => {
      if (end - start >= high - low) return start > low ? low - start : end < high ? high - end : 0;
      return start < low ? low - start : end > high ? high - end : 0;
    };
    panX += correction(diagram.left, diagram.right, viewport.left, viewport.right);
    panY += correction(diagram.top, diagram.bottom, viewport.top, viewport.bottom);
    svgWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  };
  const fit = () => {
    if (closed) return;
    svgWrapper.style.transform = '';
    const svg = svgWrapper.querySelector('svg');
    const bounds = container.getBoundingClientRect();
    const width = svg?.getBoundingClientRect().width || svg?.viewBox.baseVal.width || 0;
    const height = svg?.getBoundingClientRect().height || svg?.viewBox.baseVal.height || 0;
    baseScale = width > 0 && height > 0
      ? Math.max(0.01, Math.min((bounds.width - 80) / width, (bounds.height - 80) / height)) : 1;
    zoom = 1; panX = 0; panY = 0;
    applyTransform();
  };
  const addButton = (icon: typeof ZoomIn, label: string, action: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    button.append(createElement(icon, { width: 16, height: 16, 'aria-hidden': 'true' }));
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
    button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
    controls.append(button);
    return button;
  };
  addButton(ZoomIn, strings.zoomIn, () => { zoom = stepVisualZoom(zoom, 1); applyTransform(); });
  addButton(ZoomOut, strings.zoomOut, () => { zoom = stepVisualZoom(zoom, -1); applyTransform(); });
  addButton(RotateCcw, strings.resetZoom, fit);
  const exit = addButton(X, strings.exitFullscreen, () => viewer.close('user-close'));
  exit.classList.add('meo-mermaid-exit-btn');
  container.append(svgWrapper, controls);
  overlay.append(container);
  document.body.append(overlay);

  const viewer: MermaidFullscreenViewer = {
    update(svg) { if (!closed) svgWrapper.innerHTML = svg; },
    refreshTheme() { options.decorate?.(container); options.decorate?.(controls); },
    close(cause) {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      for (const cleanup of [
        () => events.abort(),
        () => resize.disconnect(),
        () => { if (pointerId !== null && container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId); },
        () => overlay.remove()
      ]) {
        try { cleanup(); } catch (error) { errors.push(error); }
      }
      if (activeViewer === viewer) activeViewer = null;
      try { options.onClose(cause, pointerDriven); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, `Mermaid fullscreen ${cause} cleanup failed`, { cause: errors[0] });
    }
  };
  activeViewer = viewer;
  viewer.refreshTheme();
  const signal = events.signal;
  overlay.addEventListener('pointerdown', event => {
    if (event.button === 0) { pointerDriven = true; suppressRenderedBlockPointerFocus(overlay); }
  }, { signal, capture: true });
  container.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('button, [role="button"]')) return;
    pointerId = event.pointerId;
    lastX = event.clientX; lastY = event.clientY;
    container.style.cursor = 'grabbing';
    container.setPointerCapture(pointerId);
  }, { signal });
  container.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId) return;
    panX += event.clientX - lastX; panY += event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY;
    applyTransform();
  }, { signal });
  const release = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
    pointerId = null;
    container.style.cursor = 'grab';
  };
  container.addEventListener('pointerup', release, { signal });
  container.addEventListener('pointercancel', release, { signal });
  container.addEventListener('wheel', event => {
    event.preventDefault();
    const next = stepVisualZoom(zoom, event.deltaY > 0 ? -1 : 1, 'wheel');
    const ratio = next / zoom;
    const rect = container.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2), y = event.clientY - (rect.top + rect.height / 2);
    panX = x - (x - panX) * ratio; panY = y - (y - panY) * ratio;
    zoom = next;
    applyTransform();
  }, { signal, passive: false });
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') pointerDriven = false;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); viewer.close('escape');
    } else if (event.key === 'Tab') {
      const buttons = Array.from(overlay.querySelectorAll<HTMLElement>('button:not(:disabled), [role="button"][tabindex="0"]'));
      const current = buttons.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const next = current < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }, { signal, capture: true });
  const resize = new ResizeObserver(fit);
  resize.observe(container);
  requestAnimationFrame(fit);
  (options.pointerDriven ? overlay : exit).focus({ preventScroll: true });
  return viewer;
}
