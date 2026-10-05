import { createElement, Code2, Columns2, Ellipsis, Eye } from 'lucide';
import type { RenderedBlockModeShellDecision } from '../editor/renderedBlockModeShell';

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
  button.focus({ preventScroll: true });
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
