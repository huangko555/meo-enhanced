import { getPreviewViewportResources } from './previewViewportResources';
import { createElement, Maximize2 } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { createCopyCodeButton } from './codeBlockControls';
import { cloneRenderedElement, createRenderedBlockImageButton, refreshRenderedBlockImageLabel } from './renderedBlockImage';
import { openMermaidFullscreen, type MermaidFullscreenViewer } from './mermaidFullscreen';
import { focusRenderedBlockAction, suppressRenderedBlockPointerFocus } from './renderedBlockActionFocus';

const previewViewers = new WeakMap<Document, MermaidFullscreenViewer>();

export function closePreviewBlockFullscreen(ownerDocument: Document | null): void {
  if (ownerDocument) previewViewers.get(ownerDocument)?.close('mode');
}

export function syncPreviewRenderedActions(root: ParentNode): void {
  const nearby = root.nodeType === 9 ? getPreviewViewportResources(root as Document, 'copy') : undefined;
  for (const block of nearby ?? root.querySelectorAll<HTMLElement>('.meo-export-mermaid, .meo-export-math-display')) {
    if (block.classList.contains('meo-export-code-block-wrap')) continue;
    const ready = block.classList.contains('meo-export-mermaid')
      ? block.classList.contains('is-rendered') && !block.classList.contains('is-error') && block.dataset.meoPreviewMermaidPending !== 'true'
      : Boolean(block.querySelector('.katex-display')) && !block.querySelector('.katex-error');
    for (const button of block.querySelectorAll<HTMLElement>(':scope > .meo-preview-code-actions > .meo-copy-image-btn, :scope > .meo-preview-code-actions > .meo-preview-fullscreen-btn')) {
      button.setAttribute('aria-disabled', String(!ready)); button.tabIndex = ready ? 0 : -1;
    }
  }
}

function openPreviewFullscreen(block: HTMLElement, trigger: HTMLElement, pointerDriven: boolean): void {
  const source = block.querySelector<SVGSVGElement>(':scope > .meo-export-mermaid-svg > svg');
  if (!source || block.dataset.meoPreviewMermaidPending === 'true') return;
  const ownerDocument = block.ownerDocument;
  const originalSource = block.dataset.sourceB64;
  const scroll = ownerDocument.scrollingElement;
  const scrollTop = scroll?.scrollTop ?? 0;
  const language = ownerDocument.documentElement.lang as UiLanguage;
  let signature = source.outerHTML;
  const markup = (svg: SVGSVGElement) => {
    const clone = cloneRenderedElement(svg);
    clone.style.maxWidth = '100%'; clone.style.maxHeight = '100%';
    return new XMLSerializer().serializeToString(clone);
  };
  const viewer = openMermaidFullscreen({
    svg: markup(source), uiLanguage: language, pointerDriven,
    decorate: element => {
      if (element.classList.contains('meo-mermaid-fullscreen')) {
        const styles = ownerDocument.defaultView!.getComputedStyle(ownerDocument.documentElement);
        element.style.backgroundColor = styles.getPropertyValue('--meo-bg');
      }
    },
    onClose: (cause, pointerExit) => {
      observer.disconnect();
      previewViewers.delete(ownerDocument);
      if ((cause === 'user-close' || cause === 'escape') && block.isConnected) {
        if (scroll) scroll.scrollTop = scrollTop;
        focusRenderedBlockAction(trigger, pointerExit);
      }
    }
  });
  previewViewers.set(ownerDocument, viewer);
  const observer = new MutationObserver(() => {
    if (!block.isConnected || block.dataset.sourceB64 !== originalSource || ownerDocument.documentElement.lang !== language) {
      viewer.close('external'); return;
    }
    const current = block.querySelector<SVGSVGElement>(':scope > .meo-export-mermaid-svg > svg');
    viewer.refreshTheme();
    const pending = block.dataset.meoPreviewMermaidPending === 'true';
    if (current && current.outerHTML !== signature && !pending) {
      signature = current.outerHTML; viewer.update(markup(current));
    }
  });
  observer.observe(ownerDocument.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-source-b64', 'data-meo-preview-mermaid-pending', 'lang'] });
}

// These reading controls are added only to the iframe DOM, never to shared export HTML.
export const previewCopyBlockSelector = '.meo-export-code-block-wrap, .meo-export-mermaid, .meo-export-math-display';

export function addPreviewCodeCopyControls(root: ParentNode, language: UiLanguage): void {
  const strings = getUiStrings(language);
  const nearby = root.nodeType === 9 ? getPreviewViewportResources(root as Document, 'copy') : undefined;
  for (const block of nearby ?? root.querySelectorAll<HTMLElement>(previewCopyBlockSelector)) {
    if (block.classList.contains('meo-export-mermaid')
      && !block.querySelector(':scope > .meo-export-code-language-label')) {
      const label = block.ownerDocument.createElement('div');
      label.className = 'meo-export-code-language-label';
      label.textContent = 'mermaid';
      block.prepend(label);
    }
    const code = block.querySelector<HTMLElement>(':scope > pre > code');
    if (!code && block.dataset.sourceB64 === undefined) continue;
    let button = block.querySelector<HTMLElement>(':scope > .meo-preview-code-actions > .meo-copy-code-btn');
    if (!button) {
      const copyButton = createCopyCodeButton(() => {
        // Resolve the live DOM after incremental updates and Shiki token projection.
        const currentBlock = copyButton.closest<HTMLElement>(previewCopyBlockSelector);
        if (currentBlock?.dataset.sourceB64 !== undefined) {
          const binary = window.atob(currentBlock.dataset.sourceB64);
          const source = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
          // Mermaid's render payload includes the structural newline before its fence.
          return currentBlock.classList.contains('meo-export-mermaid') ? source.replace(/\n$/, '') : source;
        }
        const currentCode = currentBlock?.querySelector(':scope > pre > code');
        if (!currentCode) return '';
        const lines = Array.from(currentCode.querySelectorAll('.meo-export-code-line-source'));
        return lines.map(line => line.textContent ?? '').join('\n');
      }, language, block.ownerDocument);
      // A mouse click must not collapse the reader's existing text selection.
      copyButton.addEventListener('mousedown', event => {
        if (event.button === 0) event.preventDefault();
      });
      const actions = block.ownerDocument.createElement('span');
      actions.className = 'meo-preview-code-actions';
      actions.addEventListener('pointerdown', event => {
        if (event.button === 0) suppressRenderedBlockPointerFocus(block.ownerDocument.documentElement);
      });
      actions.append(copyButton);
      block.append(actions);
      button = copyButton;
    }
    const actions = button.parentElement!;
    if (!block.classList.contains('meo-export-code-block-wrap') && !actions.querySelector('.meo-copy-image-btn')) {
      actions.prepend(createRenderedBlockImageButton(block, language));
    }
    if (block.classList.contains('meo-export-mermaid') && !actions.querySelector('.meo-preview-fullscreen-btn')) {
      const fullscreen = block.ownerDocument.createElement('span');
      fullscreen.className = 'meo-preview-fullscreen-btn';
      fullscreen.setAttribute('role', 'button'); fullscreen.tabIndex = 0;
      fullscreen.append(block.ownerDocument.importNode(createElement(Maximize2, { width: 15, height: 15, 'aria-hidden': 'true' }), true));
      const open = (event: Event) => {
        event.preventDefault(); event.stopPropagation();
        const current = fullscreen.closest<HTMLElement>('.meo-export-mermaid');
        if (current && fullscreen.getAttribute('aria-disabled') !== 'true') {
          openPreviewFullscreen(current, fullscreen, event.type === 'click' && (event as MouseEvent).detail > 0);
        }
      };
      fullscreen.addEventListener('click', open);
      fullscreen.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') open(event); });
      fullscreen.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
      actions.prepend(fullscreen);
    }
    const fullscreen = actions.querySelector<HTMLElement>('.meo-preview-fullscreen-btn');
    const image = actions.querySelector<HTMLElement>('.meo-copy-image-btn');
    if (image) refreshRenderedBlockImageLabel(image, language);
    if (fullscreen) { fullscreen.dataset.tooltip = strings.fullscreen; fullscreen.setAttribute('aria-label', strings.fullscreen); }
    button.dataset.tooltip = strings.copyCode;
    button.setAttribute('aria-label', strings.copyCode);
  }
  syncPreviewRenderedActions(root);
}
