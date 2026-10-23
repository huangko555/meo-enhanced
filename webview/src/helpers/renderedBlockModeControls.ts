import { createElement, Code2, Columns2, Ellipsis, Eye } from 'lucide';
import type { RenderedBlockModeShellDecision } from '../editor/renderedBlockModeShell';
import type { EditorView } from '@codemirror/view';
import { measureFixedContainingBlockMapping } from '../editor/fixedChromeDomGeometry';
import { projectFixedChromeGeometry, type FixedChromeRect } from '../editor/fixedChromeGeometry';
import { focusRenderedBlockAction } from './renderedBlockActionFocus';

/** A single preview-owned group follows the visible diagram, outside document layout.
 * Both normal and split previews use these same controls and zoom state. */
export function mountMermaidPreviewControls(root: HTMLElement, controls: HTMLElement, editor?: EditorView): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const events = new win.AbortController();
  const margin = 6;
  let frame = 0;
  let disposed = false;
  const geometry = new win.MutationObserver(() => requestMeasure());
  const observedAncestors = new WeakSet<Element>();
  controls.classList.add('meo-mermaid-preview-controls', 'is-outside-viewport');
  const measure = (): { rect: FixedChromeRect; columns: number } | null => {
    if (!root.isConnected || doc.querySelector('.meo-mermaid-fullscreen-scrim')) return null;
    // Host transforms/zoom need a fresh fixed-coordinate mapping even when
    // ResizeObserver sees unchanged layout sizes. Never observe our own writes.
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      if (!observedAncestors.has(parent)) {
        geometry.observe(parent, { attributes: true, attributeFilter: ['style', 'class'] });
        observedAncestors.add(parent);
      }
    }
    const diagram = root.getBoundingClientRect();
    const scroller = editor?.scrollDOM ?? root.closest<HTMLElement>('.cm-scroller');
    let left = Math.max(0, diagram.left), right = Math.min(win.innerWidth, diagram.right);
    let top = Math.max(0, diagram.top), bottom = Math.min(win.innerHeight, diagram.bottom);
    if (scroller) {
      const viewport = scroller.getBoundingClientRect();
      const sx = viewport.width / Math.max(1, scroller.offsetWidth);
      const sy = viewport.height / Math.max(1, scroller.offsetHeight);
      left = Math.max(left, viewport.left + scroller.clientLeft * sx);
      right = Math.min(right, viewport.left + (scroller.clientLeft + scroller.clientWidth) * sx);
      top = Math.max(top, viewport.top + scroller.clientTop * sy);
      bottom = Math.min(bottom, viewport.top + (scroller.clientTop + scroller.clientHeight) * sy);
    }
    const pane = root.closest<HTMLElement>('.meo-rendered-block-preview-pane');
    if (pane) {
      const bounds = pane.getBoundingClientRect();
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
    const header = root.closest('.cm-editor')?.querySelector<HTMLElement>('.meo-block-sticky-header:not([hidden])');
    if (header) top = Math.max(top, header.getBoundingClientRect().bottom);
    const bounds = controls.getBoundingClientRect();
    const twoRows = controls.dataset.meoControlsColumns === '2';
    const sx = bounds.width / (twoRows ? 55 : 105), sy = bounds.height / (twoRows ? 51 : 28);
    if (sx <= 0 || sy <= 0) return null;
    const columns = right - left < 105 * sx + margin * 2 ? 2 : 4;
    const width = (columns === 2 ? 55 : 105) * sx, height = (columns === 2 ? 51 : 28) * sy;
    if (right - left < width + margin * 2 || bottom - top < height + margin * 2) return null;
    const mapping = measureFixedContainingBlockMapping(controls);
    if (!mapping) return null;
    const projection = projectFixedChromeGeometry(mapping, {
      rect: { left: right - width - margin, top: bottom - height - margin, width, height }, vectors: []
    });
    return projection.ok ? { rect: projection.geometry.rect, columns } : null;
  };
  const render = (value: ReturnType<typeof measure>) => {
    if (disposed) return;
    controls.classList.toggle('is-outside-viewport', !value);
    if (!value) return;
    controls.dataset.meoControlsColumns = String(value.columns);
    const left = `${value.rect.left}px`, top = `${value.rect.top}px`;
    if (controls.style.left !== left) controls.style.left = left;
    if (controls.style.top !== top) controls.style.top = top;
  };
  const requestMeasure = () => {
    if (disposed) return;
    if (editor) {
      editor.requestMeasure({ key: controls, read: measure, write: render });
    } else if (!frame) {
      frame = win.requestAnimationFrame(() => { frame = 0; render(measure()); });
    }
  };
  const resize = new win.ResizeObserver(requestMeasure);
  resize.observe(root); resize.observe(controls);
  if (editor) resize.observe(editor.scrollDOM);
  const intersection = new win.IntersectionObserver(requestMeasure);
  intersection.observe(root);
  const fullscreen = new win.MutationObserver(requestMeasure);
  fullscreen.observe(doc.body, { childList: true });
  doc.addEventListener('scroll', requestMeasure, { capture: true, passive: true, signal: events.signal });
  win.addEventListener('resize', requestMeasure, { passive: true, signal: events.signal });
  requestMeasure();
  return () => {
    disposed = true;
    if (frame) win.cancelAnimationFrame(frame);
    events.abort(); resize.disconnect(); intersection.disconnect(); fullscreen.disconnect(); geometry.disconnect();
    controls.remove();
  };
}

export function renderRenderedBlockModeButton(
  button: HTMLButtonElement,
  decision: RenderedBlockModeShellDecision
): void {
  const icon = decision.modeButton.action === 'edit'
    ? Columns2
    : decision.modeButton.action === 'source'
      ? Code2
      : Eye;
  button.replaceChildren(createElement(icon, { width: 15, height: 15 }));
  button.setAttribute('aria-label', decision.modeButton.label);
  button.dataset.tooltip = decision.modeButton.label;
  button.dataset.tooltipLiveUpdate = 'true';
}

const modeButtonFocus = new WeakMap<HTMLButtonElement, { hovered: boolean; pointerFocus: boolean }>();

export function retainRenderedBlockModePointerFocus(button: HTMLButtonElement): void {
  const state = { hovered: false, pointerFocus: false };
  modeButtonFocus.set(button, state);
  button.addEventListener('mouseenter', () => { state.hovered = true; });
  button.addEventListener('mouseleave', () => {
    state.hovered = false;
    if (state.pointerFocus) button.blur();
  });
  button.addEventListener('blur', () => { state.pointerFocus = false; });
  button.addEventListener('keydown', () => { state.pointerFocus = false; });
  button.addEventListener('pointerdown', (event) => {
    if (event.button === 0) {
      state.hovered = true;
      // Keep the embedded source editor alive until the click handler has
      // committed the mode transition. A pointer-driven blur can otherwise
      // project pending input and replace the toolbar before `click` fires.
      event.preventDefault();
    }
  });
}

/** Restore focus after returning to preview; pointer focus lasts only while hovered. */
export function restoreRenderedBlockModeFocus(button: HTMLButtonElement | null, pointerDriven: boolean): void {
  if (!button) return;
  const state = modeButtonFocus.get(button);
  if (state) state.pointerFocus = pointerDriven;
  // Programmatic focus inherits the embedded text editor's :focus-visible state.
  // The shared focus styles need the pointer origin before focus is restored.
  focusRenderedBlockAction(button, pointerDriven);
  // The toolbar can be reparented before this restoration. Use its tracked
  // hover session, and also handle a pointer that left before the queued frame.
  if (pointerDriven && !state?.hovered) button.blur();
}

type PreviewControlsOwner = {
  readonly root: HTMLElement;
  readonly createControls: () => HTMLElement;
  readonly overflowLabel: string;
};
const previewControlsOwners = new WeakMap<HTMLElement, PreviewControlsOwner>();

/** The preview remains the sole owner of zoom, pan and fullscreen state. */
export function getRenderedBlockPreviewControlsOwner(shell: HTMLElement): PreviewControlsOwner | null {
  for (const root of [shell, ...shell.querySelectorAll<HTMLElement>('.meo-mermaid-block, .meo-md-math-display')]) {
    const owner = previewControlsOwners.get(root);
    if (owner) return owner;
  }
  return null;
}

export function mountFloatingRenderedBlockPreviewControls(
  owner: PreviewControlsOwner,
  toolbar: HTMLElement,
  header: HTMLElement
): () => void {
  return mountPreviewControlsInToolbar(toolbar, header, owner.createControls(), owner.overflowLabel);
}

function mountPreviewControlsInToolbar(
  toolbar: HTMLElement,
  shell: HTMLElement,
  controls: HTMLElement,
  overflowLabel: string
): () => void {
  const doc = toolbar.ownerDocument;
  const view = doc.defaultView!;
  const events = new view.AbortController();
  const group = doc.createElement('details');
  group.className = 'meo-rendered-block-preview-actions';
  group.open = true;
  const summary = doc.createElement('summary');
  summary.setAttribute('aria-label', overflowLabel);
  summary.dataset.tooltip = overflowLabel;
  summary.append(createElement(Ellipsis, { width: 15, height: 15, 'aria-hidden': 'true' }));
  group.append(summary, controls);
  toolbar.querySelector(':scope > .meo-rendered-block-preview-actions')?.remove();
  toolbar.prepend(group);
  const updateLayout = () => {
    const collapsed = shell.getBoundingClientRect().width < 300;
    if (group.classList.contains('is-collapsed') === collapsed) return;
    group.classList.toggle('is-collapsed', collapsed);
    group.open = !collapsed;
  };
  updateLayout();
  const resize = new view.ResizeObserver(updateLayout);
  resize.observe(shell);
  const closeOutside = (event: Event) => {
    if (group.classList.contains('is-collapsed') && !group.contains(event.target as Node)) group.open = false;
  };
  group.addEventListener('toggle', () => {
    doc.removeEventListener('pointerdown', closeOutside, true);
    if (group.open && group.classList.contains('is-collapsed')) {
      doc.addEventListener('pointerdown', closeOutside, true);
    }
  }, { signal: events.signal });
  group.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !group.classList.contains('is-collapsed')) return;
    event.preventDefault(); event.stopPropagation();
    group.open = false;
    summary.focus({ preventScroll: true });
  }, { signal: events.signal });
  return () => {
    events.abort(); resize.disconnect();
    doc.removeEventListener('pointerdown', closeOutside, true);
    group.remove();
  };
}

/** Keeps preview-owned controls in the block toolbar; disposal removes both surfaces' owner. */
export function mountRenderedBlockPreviewControls(
  root: HTMLElement,
  controls: HTMLElement,
  overflowLabel: string,
  createControls?: () => HTMLElement
): () => void {
  const view = root.ownerDocument.defaultView!;
  let frame = 0;
  let cleanup: (() => void) | null = null;
  let toolbarOwner: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  if (createControls) previewControlsOwners.set(root, { root, createControls, overflowLabel });
  const mount = () => {
    frame = 0;
    const shell = root.closest<HTMLElement>('.meo-rendered-block-preview, .meo-rendered-block-mode-shell');
    if (!shell) return;
    const content = shell.closest('.cm-editor')?.querySelector('.cm-content');
    if (!observer && content) {
      // The opening-line widget may mount after its preview when scrolling back.
      observer = new view.MutationObserver(mount);
      observer.observe(content, { childList: true, subtree: true });
    }
    const anchor = shell.dataset.meoMermaidAnchor ?? shell.dataset.meoLatexMathAnchor;
    const toolbar = shell.matches('.meo-rendered-block-preview')
      ? shell.querySelector<HTMLElement>('.meo-mermaid-toolbar, .meo-latex-math-toolbar')
      : anchor && /^\d+$/.test(anchor)
        ? shell.closest('.cm-editor')?.querySelector<HTMLElement>(
          `:is(.meo-mermaid-toolbar, .meo-latex-math-toolbar)[data-meo-block-from="${anchor}"]:not([data-meo-floating])`
        ) : null;
    if (!toolbar || (toolbar === toolbarOwner && controls.parentElement?.parentElement === toolbar)) return;
    cleanup?.();
    toolbarOwner = toolbar;
    cleanup = mountPreviewControlsInToolbar(toolbar, shell, controls, overflowLabel);
  };
  mount();
  // Formula controls are created before CodeMirror mounts their preview shell.
  if (!cleanup && !root.isConnected) frame = view.requestAnimationFrame(mount);
  return () => {
    if (frame) view.cancelAnimationFrame(frame);
    observer?.disconnect();
    previewControlsOwners.delete(root);
    cleanup?.();
  };
}
