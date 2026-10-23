import { createElement, Check, Image, LoaderCircle, TriangleAlert } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';

const imageButtonLabels = new WeakMap<HTMLElement, (language: UiLanguage) => void>();
const imageButtonAvailability = new WeakMap<HTMLElement, () => void>();

export function refreshRenderedBlockImageLabel(button: HTMLElement, language: UiLanguage): void {
  imageButtonLabels.get(button)?.(language);
}

/** One editor-owned observer follows rendered results and virtualized toolbars, never ordinary text input. */
export function observeRenderedBlockImageAvailability(root: HTMLElement): () => void {
  const refresh = () => {
    for (const button of root.querySelectorAll<HTMLElement>('.meo-copy-image-btn')) imageButtonAvailability.get(button)?.();
  };
  const rendered = '.meo-copy-image-btn, .meo-md-math-fenced-display, .meo-mermaid-block';
  const observer = new root.ownerDocument.defaultView!.MutationObserver(records => {
    if (records.some(record => record.type === 'attributes'
      || (record.target instanceof Element && record.target.closest('.meo-md-math-fenced-display, .meo-mermaid-block'))
      || Array.from(record.addedNodes).some(node => node instanceof Element && (node.matches(rendered) || node.querySelector(rendered))))) refresh();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: [
    'data-meo-math-stale', 'data-meo-math-anchor', 'data-meo-mermaid-rendering',
    'data-meo-block-from', 'data-meo-mermaid-mode', 'data-meo-mermaid-anchor', 'data-meo-rendered-block-start-line'
  ] });
  refresh();
  return () => observer.disconnect();
}

/** Resolve inherited styles before a rendered result leaves its Preview iframe. */
export function cloneRenderedElement<T extends Element>(source: T): T {
  const clone = source.cloneNode(true) as T;
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  const ownerWindow = source.ownerDocument.defaultView!;
  originals.forEach((element, index) => {
    const style = ownerWindow.getComputedStyle(element);
    const target = copies[index] as HTMLElement | SVGElement;
    for (const property of style) target.style.setProperty(property, style.getPropertyValue(property));
  });
  return clone;
}

function fontStyles(ownerDocument: Document): string {
  const rules: string[] = [];
  for (const sheet of Array.from(ownerDocument.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        // Production KaTeX embeds fonts as data URLs. Image contexts cannot load external fonts.
        if (rule.type === CSSRule.FONT_FACE_RULE && rule.cssText.includes('data:')) rules.push(rule.cssText);
        if (rule.cssText.includes('.katex') && rule.cssText.includes('::before')) rules.push(rule.cssText);
      }
    } catch { /* Unrelated cross-origin stylesheets do not own the rendered result's fonts. */ }
  }
  return rules.join('\n');
}

async function renderBlockPng(block: HTMLElement): Promise<Blob> {
  const ownerDocument = block.ownerDocument;
  await ownerDocument.fonts.ready;
  const svgSource = block.querySelector<SVGSVGElement>(':scope > .meo-export-mermaid-svg > svg, :scope > .meo-mermaid-svg-wrapper > svg');
  const mathSource = block.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas > .katex-display, :scope > .katex-display');
  const source = svgSource ?? mathSource;
  if (!block.isConnected || !source || block.querySelector('.katex-error')
    || block.classList.contains('is-error') || block.dataset.meoPreviewMermaidPending === 'true') {
    throw new Error('The current rendered result is unavailable');
  }
  const signature = source.outerHTML;
  const clone = cloneRenderedElement(source);
  clone.querySelectorAll('.katex-mathml').forEach(element => element.remove());
  const style = (clone as HTMLElement | SVGElement).style;
  style.transform = 'none'; style.zoom = '1'; style.margin = '0';
  style.maxWidth = 'none'; style.maxHeight = 'none'; style.overflow = 'visible';
  let width: number, height: number;
  let left = 0, top = 0;
  let contentWidth = 0, contentHeight = 0;
  if (svgSource) {
    width = svgSource.viewBox.baseVal.width || svgSource.getBoundingClientRect().width;
    height = svgSource.viewBox.baseVal.height || svgSource.getBoundingClientRect().height;
    style.width = `${width}px`; style.height = `${height}px`;
  } else {
    contentWidth = Math.max(mathSource!.offsetWidth, mathSource!.scrollWidth);
    contentHeight = Math.max(mathSource!.offsetHeight, mathSource!.scrollHeight);
    const bounds = mathSource!.getBoundingClientRect();
    const scale = bounds.width / mathSource!.offsetWidth || 1;
    const parts = Array.from(mathSource!.querySelectorAll<HTMLElement>('.katex-html .base, .katex-html > .tag'))
      .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    left = parts.length ? (Math.min(...parts.map(rect => rect.left)) - bounds.left) / scale : 0;
    top = parts.length ? (Math.min(...parts.map(rect => rect.top)) - bounds.top) / scale : 0;
    width = parts.length ? (Math.max(...parts.map(rect => rect.right)) - bounds.left) / scale - left : contentWidth;
    height = parts.length ? (Math.max(...parts.map(rect => rect.bottom)) - bounds.top) / scale - top : contentHeight;
    // Preserve the current line breaks, while allowing the output to include overflow and tags.
    style.width = `${mathSource!.offsetWidth}px`; style.height = `${mathSource!.offsetHeight}px`;
  }
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Empty rendered result');
  if (Array.from(clone.querySelectorAll('image')).some(image => {
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
    return href && !href.startsWith('data:') && !href.startsWith('#');
  })) throw new Error('External diagram images cannot be embedded');
  const padding = 16;
  const outputWidth = Math.ceil(width + padding * 2), outputHeight = Math.ceil(height + padding * 2);
  const scale = Math.min(2, 8192 / outputWidth, 8192 / outputHeight, Math.sqrt(16_000_000 / (outputWidth * outputHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(outputWidth * scale));
  canvas.height = Math.max(1, Math.floor(outputHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.scale(scale, scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.fillStyle = ownerDocument.defaultView!.getComputedStyle(block).getPropertyValue('--meo-bg').trim() || '#ffffff';
  context.fillRect(0, 0, outputWidth, outputHeight);
  const ancestors: Element[] = [];
  for (let element: Element | null = block; element; element = element.parentElement) ancestors.unshift(element);
  for (const element of ancestors) {
    context.fillStyle = ownerDocument.defaultView!.getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, outputWidth, outputHeight);
  }
  const ns = 'http://www.w3.org/2000/svg';
  const snapshot = document.createElementNS(ns, 'svg');
  snapshot.setAttribute('width', String(outputWidth)); snapshot.setAttribute('height', String(outputHeight));
  const fonts = document.createElementNS(ns, 'style');
  fonts.textContent = fontStyles(ownerDocument);
  snapshot.append(fonts);
  const foreign = document.createElementNS(ns, 'foreignObject');
  foreign.setAttribute('x', String(padding - left)); foreign.setAttribute('y', String(padding - top));
  foreign.setAttribute('width', String(contentWidth || width)); foreign.setAttribute('height', String(contentHeight || height));
  const content = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  content.style.width = `${contentWidth || width}px`; content.style.height = `${contentHeight || height}px`;
  content.append(document.importNode(clone, true));
  foreign.append(content); snapshot.append(foreign);
  const image = new window.Image();
  // A data URL keeps Chromium's foreignObject canvas origin-clean; blob URLs do not.
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(snapshot));
  await image.decode();
  if (!block.isConnected || !source.isConnected || source.outerHTML !== signature) throw new Error('The rendered result changed while copying');
  context.drawImage(image, 0, 0, outputWidth, outputHeight);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
}

/** A getter resolves virtualized Live results at activation, rather than retaining a replaced widget. */
export function createRenderedBlockImageButton(
  target: HTMLElement | (() => HTMLElement | null),
  language: UiLanguage,
  ownerDocument: Document = typeof target === 'function' ? document : target.ownerDocument
): HTMLElement {
  const getBlock = typeof target === 'function' ? target : () => target;
  const button = ownerDocument.createElement('span');
  button.className = 'meo-copy-image-btn';
  button.setAttribute('role', 'button'); button.tabIndex = 0;
  button.dataset.tooltipLiveUpdate = 'true';
  const status = ownerDocument.createElement('span');
  status.className = 'meo-preview-action-status';
  status.setAttribute('role', 'status');
  let busy = false;
  let currentLanguage = language;
  let currentState: 'idle' | 'busy' | 'copied' | 'error' = 'idle';
  let feedbackTimeout: ReturnType<typeof setTimeout> | undefined;
  const update = (state: 'idle' | 'busy' | 'copied' | 'error') => {
    currentState = state;
    const strings = getUiStrings(currentLanguage);
    const label = state === 'busy' ? strings.copyingImage : state === 'copied' ? strings.copiedImage
      : state === 'error' ? strings.copyImageFailed : strings.copyImage;
    button.dataset.tooltip = label; button.setAttribute('aria-label', label);
    button.setAttribute('aria-busy', String(state === 'busy'));
    button.classList.toggle('copied', state === 'copied');
    button.replaceChildren(ownerDocument.importNode(createElement(
      state === 'busy' ? LoaderCircle : state === 'copied' ? Check : state === 'error' ? TriangleAlert : Image,
      { width: 15, height: 15, 'aria-hidden': 'true' }
    ), true));
    status.textContent = state === 'error' ? label : '';
    if (state === 'error') button.parentElement?.append(status);
    else status.remove();
  };
  const refreshAvailability = () => {
    if (typeof target === 'function') {
      const disabled = String(getBlock() === null);
      if (button.getAttribute('aria-disabled') !== disabled) button.setAttribute('aria-disabled', disabled);
    }
  };
  if (typeof target === 'function') imageButtonAvailability.set(button, refreshAvailability);
  imageButtonLabels.set(button, language => { currentLanguage = language; update(currentState); });
  const copy = async (event: Event) => {
    event.preventDefault(); event.stopPropagation();
    refreshAvailability();
    if (busy || button.getAttribute('aria-disabled') === 'true') return;
    busy = true; clearTimeout(feedbackTimeout); update('busy');
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image clipboard is unavailable');
      const block = getBlock();
      if (!block) throw new Error('The current rendered result is unavailable');
      // Start the write in the user's gesture. Encoding may finish after activation expires.
      const png = renderBlockPng(block).then(blob => {
        if (getBlock() !== block || button.getAttribute('aria-disabled') === 'true') {
          throw new Error('The rendered result changed while copying');
        }
        return blob;
      });
      // A denied write may never consume the payload promise.
      void png.catch(() => undefined);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      if (button.isConnected) {
        update('copied');
        feedbackTimeout = setTimeout(() => { if (button.isConnected) update('idle'); }, 2000);
      }
    } catch (error) {
      console.error('Failed to copy image:', error);
      if (button.isConnected) update('error');
    } finally { busy = false; }
  };
  update('idle');
  refreshAvailability();
  button.addEventListener('pointerenter', refreshAvailability);
  button.addEventListener('focus', refreshAvailability);
  button.addEventListener('click', copy);
  button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') void copy(event); });
  button.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
  return button;
}
