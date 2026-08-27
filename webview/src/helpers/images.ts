import { EditorView, WidgetType } from '@codemirror/view';
import { AppWindow, createElement, ExternalLink, Maximize2, RotateCcw, SquareArrowRightEnter, X, ZoomIn, ZoomOut } from 'lucide';
import { getViewportController } from './viewportController';
import { createImageResolutionTransport, type ImageResolutionTransport } from '../adapters/imageResolutionTransport';
import { createClipboardImageSaveTransport, type ClipboardImageSaveTransport } from '../adapters/clipboardImageSaveTransport';
import type { ResolvedImageSrcResponse } from '../../../src/protocol/imageResolution';
import type { SavedImagePathResponse } from '../../../src/protocol/clipboardImageSave';
import type {
  ImagePresentationFactory,
  ImagePresentationHandle
} from '../editor/imagePresentation';
import { getUiStrings, type UiLanguage } from '../../../src/foundation/uiLanguage';

const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;

type ImageSrcResolver = (
  url: string,
  signal?: AbortSignal
) => string | Promise<string | null | undefined> | null | undefined;

let imageSrcResolver: ImageSrcResolver = (url) => url;
let vscodeApi: any = null;
let imageResolutionTransport: ImageResolutionTransport = {
  resolve: async () => ({
    ok: false,
    error: { code: 'operation-failed', message: 'Image handling is not initialized' }
  }),
  accept: () => false
};
let clipboardImageSaveTransport: ClipboardImageSaveTransport = {
  save: async () => ({
    ok: false,
    error: { code: 'operation-failed', message: 'Image handling is not initialized' }
  }),
  accept: () => false
};

const IMAGE_DOUBLE_CLICK_WINDOW_MS = 400;
const IMAGE_DOUBLE_CLICK_MAX_DISTANCE_PX = 8;
const IMAGE_PRESENTATION_DISPOSE_EVENT = 'meo-dispose-image-presentation';
type ImageDoubleClickCandidate = {
  x: number;
  y: number;
  openFullscreen: () => void;
  timeout: number;
};
let pendingImageDoubleClick: ImageDoubleClickCandidate | null = null;
let imageDoubleClickListenerInitialized = false;

const imageExtensionByMime: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/icon': 'ico',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'image/x-icon': 'ico'
};

export function initializeImageHandling(vscode: any): void {
  vscodeApi = vscode;
  imageResolutionTransport = createImageResolutionTransport((message) => {
    vscodeApi?.postMessage(message);
  });
  clipboardImageSaveTransport = createClipboardImageSaveTransport((message) => {
    vscodeApi?.postMessage(message);
  });
  if (imageDoubleClickListenerInitialized) return;
  imageDoubleClickListenerInitialized = true;
  window.addEventListener('click', (event) => {
    const pending = pendingImageDoubleClick;
    if (!pending) return;
    clearPendingImageDoubleClick();
    if (
      event.ctrlKey ||
      event.metaKey ||
      Math.abs(event.clientX - pending.x) > IMAGE_DOUBLE_CLICK_MAX_DISTANCE_PX ||
      Math.abs(event.clientY - pending.y) > IMAGE_DOUBLE_CLICK_MAX_DISTANCE_PX
    ) return;
    event.preventDefault();
    event.stopPropagation();
    pending.openFullscreen();
  }, true);
}

function clearPendingImageDoubleClick(): void {
  if (!pendingImageDoubleClick) return;
  window.clearTimeout(pendingImageDoubleClick.timeout);
  pendingImageDoubleClick = null;
}

function registerImageDoubleClickCandidate(event: MouseEvent, openFullscreen: () => void): void {
  clearPendingImageDoubleClick();
  const pending = {
    x: event.clientX,
    y: event.clientY,
    openFullscreen,
    timeout: window.setTimeout(clearPendingImageDoubleClick, IMAGE_DOUBLE_CLICK_WINDOW_MS)
  };
  pendingImageDoubleClick = pending;
}

const openImageExternally = (url: string): void => {
  vscodeApi?.postMessage({ type: 'openImageExternally', url });
};

const isImmediateImageSrc = (url: string): boolean => /^(?:https?:|data:|blob:|vscode-webview:|vscode-webview-resource:|vscode-resource:)/i.test(url);

const requestImageSrcResolution = async (url: string, signal?: AbortSignal): Promise<string> => {
  const result = await imageResolutionTransport.resolve(url, signal);
  const resolvedUrl = result.ok === true ? result.value.resolvedUrl : '';
  return resolvedUrl || url;
};

export const settleImageSrcRequest = (message: ResolvedImageSrcResponse): void => {
  imageResolutionTransport.accept(message);
};

export const resolveImageSrc = (
  rawUrl: string | null | undefined,
  signal?: AbortSignal
): string | Promise<string> => {
  const url = (rawUrl ?? '').trim();
  if (!url || isImmediateImageSrc(url)) {
    return url;
  }
  return requestImageSrcResolution(url, signal);
};

export const resolveConfiguredImageSrc = async (
  rawUrl: string,
  signal?: AbortSignal
): Promise<string | null> => {
  const resolved = await imageSrcResolver(rawUrl, signal);
  return resolved || null;
};

export const parseDataUrlMimeType = (dataUrl: string): string => {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? '';
};

const fallbackImageExtensionFromMimeType = (mimeType: string): string => {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized.startsWith('image/')) {
    return '';
  }

  const subtype = normalized.slice('image/'.length).replace(/\+xml$/, '').replace(/^x-/, '');
  const sanitized = subtype.replace(/[^a-z0-9.+-]/g, '');
  return sanitized || '';
};

export const imageExtensionFromMimeType = (mimeType: string): string => (
  imageExtensionByMime[mimeType.trim().toLowerCase()] ?? fallbackImageExtensionFromMimeType(mimeType)
);

export const handleSavedImagePath = (message: SavedImagePathResponse): void => {
  clipboardImageSaveTransport.accept(message);
};

export interface ImagePasteContext {
  lineNumber: number;
  lineOffset: number;
  onError?: (message: string) => void;
}

export const handleImagePaste = async (
  event: ClipboardEvent,
  editor: any,
  context: ImagePasteContext
): Promise<boolean> => {
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return false;
  }

  const imageCandidates: Array<{ blob: Blob; mimeType: string }> = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (!item.type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (blob) imageCandidates.push({ blob, mimeType: item.type });
  }
  if (imageCandidates.length === 0) {
    for (const file of Array.from(clipboardData.files ?? [])) {
      if (file.type.startsWith('image/')) imageCandidates.push({ blob: file, mimeType: file.type });
    }
  }

  const tableInput = document.activeElement instanceof HTMLTextAreaElement &&
    document.activeElement.closest('.meo-md-html-table')
    ? document.activeElement
    : null;
  const tableSelection = tableInput
    ? {
        start: tableInput.selectionStart ?? 0,
        end: tableInput.selectionEnd ?? tableInput.selectionStart ?? 0
      }
    : null;

  for (const { blob, mimeType } of imageCandidates) {

    event.preventDefault();
    event.stopPropagation();

    let imageData = '';
    try {
      imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read pasted image'));
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      context.onError?.(error instanceof Error ? error.message : 'Failed to read pasted image');
      return true;
    }

    if (!imageData) {
      return true;
    }

    const timestamp = Date.now();
    const dataUrlMimeType = parseDataUrlMimeType(imageData);
    const extension = (
      imageExtensionFromMimeType(dataUrlMimeType) ||
      imageExtensionFromMimeType(mimeType) ||
      'png'
    );
    const fileName = `${timestamp}.${extension}`;

    const result = await clipboardImageSaveTransport.save({
      imageData,
      fileName
    });

    try {
      if (result.ok === true) {
        const imageMarkdown = `![${fileName}](${result.value.path})`;
        if (tableInput && tableSelection && tableInput.isConnected) {
          tableInput.setRangeText(imageMarkdown, tableSelection.start, tableSelection.end, 'end');
          tableInput.dispatchEvent(new Event('input', { bubbles: true }));
          tableInput.focus({ preventScroll: true });
          return true;
        }
        const currentState = editor.view.state;
        const targetLineNumber = Math.min(context.lineNumber, currentState.doc.lines);
        const targetLine = currentState.doc.line(targetLineNumber);
        const insertAt = Math.min(targetLine.to, targetLine.from + context.lineOffset);
        editor.view.dispatch({
          changes: { from: insertAt, to: insertAt, insert: imageMarkdown },
          selection: { anchor: insertAt + imageMarkdown.length }
        });
        editor.focus();
      } else {
        context.onError?.(result.error.message);
      }
    } catch (error) {
      console.error('[MEO image paste]', error);
      context.onError?.(error instanceof Error ? error.message : 'Failed to paste image');
    }

    return true;
  }

  return false;
};

export function setImageSrcResolver(resolver: ImageSrcResolver): void {
  imageSrcResolver = typeof resolver === 'function' ? resolver : ((url) => url);
}

export function isImageUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  return IMAGE_EXT_RE.test(url);
}

export class ImageWidget extends WidgetType {
  url: string;
  altText: string;
  linkUrl: string;
  sourceFrom: number | null;
  pointerInteractionOwner: 'widget' | 'parent';
  fullscreenOverlay: HTMLElement | null;
  fullscreenCleanup: (() => void) | null;
  exitFullscreenHandler: ((event: KeyboardEvent) => void) | null;
  presentationHandle: ImagePresentationHandle | null;
  uiLanguage: UiLanguage;

  constructor(
    url: string | null | undefined,
    altText: string | null | undefined,
    linkUrl: string | null | undefined,
    sourceFrom: number | null = null,
    readonly presentationFactory: ImagePresentationFactory,
    options: {
      pointerInteractionOwner?: 'widget' | 'parent';
      uiLanguage?: UiLanguage;
    } = {}
  ) {
    super();
    this.url = url?.trim() ?? '';
    this.altText = altText ?? '';
    this.linkUrl = linkUrl?.trim() ?? '';
    this.sourceFrom = Number.isInteger(sourceFrom) ? sourceFrom : null;
    this.pointerInteractionOwner = options.pointerInteractionOwner ?? 'widget';
    this.fullscreenOverlay = null;
    this.fullscreenCleanup = null;
    this.exitFullscreenHandler = null;
    this.presentationHandle = null;
    this.uiLanguage = options.uiLanguage ?? 'en';
    if (this.url) {
      void this.presentationFactory.preload(this.url);
    }
  }

  eq(other: ImageWidget): boolean {
    return (
      other instanceof ImageWidget &&
      other.url === this.url &&
      other.altText === this.altText &&
      other.linkUrl === this.linkUrl &&
      other.sourceFrom === this.sourceFrom &&
      other.pointerInteractionOwner === this.pointerInteractionOwner &&
      other.uiLanguage === this.uiLanguage
    );
  }

  toDOM(view?: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'meo-md-image';

    if (this.linkUrl) {
      container.classList.add('meo-md-image-linked');
      container.setAttribute('data-meo-link-href', this.linkUrl);
    }

    if (!this.url) {
      this.renderFallback(container);
      return container;
    }
    if (this.pointerInteractionOwner === 'widget') {
      this.attachImagePointerInteractions(container);
    }

    this.presentationHandle?.dispose();
    const presentationHandle = this.presentationFactory.create({
      showFallback: () => {
        this.renderFallback(container);
        return true;
      },
      showImage: (loadedImage) => {
        const image = this.createDisplayImage(loadedImage);
        container.classList.remove('meo-md-image-fallback');
        container.replaceChildren(image, this.createImageControls(image));
        return true;
      },
      preserveLayoutChange: (apply) => this.preserveImageLayoutChange(container, view, apply)
    });
    this.presentationHandle = presentationHandle;
    container.addEventListener(IMAGE_PRESENTATION_DISPOSE_EVENT, () => {
      presentationHandle.dispose();
      if (this.presentationHandle === presentationHandle) this.presentationHandle = null;
    }, { once: true });
    presentationHandle.present(this.fallbackText(), this.url);
    return container;
  }

  createDisplayImage(cachedImage: HTMLImageElement): HTMLImageElement {
    const img = cachedImage.cloneNode(false) as HTMLImageElement;
    img.className = 'meo-md-image-img';
    img.alt = this.altText;
    img.loading = 'eager';
    return img;
  }

  attachImagePointerInteractions(container: HTMLElement): void {
    const isControlTarget = (target: EventTarget | null) => (
      target instanceof Element && target.closest('.meo-md-image-controls') !== null
    );
    const activateSource = () => {
      if (this.sourceFrom === null) return;
      container.dispatchEvent(new CustomEvent('meo-activate-image', {
        bubbles: true,
        detail: { from: this.sourceFrom }
      }));
    };
    container.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || isControlTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    });
    container.addEventListener('click', (event) => {
      if (isControlTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        this.openLinkedImage(container);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const img = container.querySelector<HTMLImageElement>('.meo-md-image-img');
      const openFullscreen = () => this.openFullscreen(img?.currentSrc || img?.src || this.url);
      activateSource();
      registerImageDoubleClickCandidate(event, openFullscreen);
    });
  }

  openLinkedImage(target: HTMLElement): void {
    if (!this.linkUrl) return;
    target.dispatchEvent(new CustomEvent('meo-open-link', {
      bubbles: true,
      detail: { href: this.linkUrl }
    }));
  }

  preserveImageLayoutChange(
    container: HTMLElement,
    view: EditorView | undefined,
    apply: () => boolean
  ): boolean | Promise<boolean> {
    if (!view || !container.isConnected) {
      return apply();
    }

    const controller = getViewportController(view);
    const sourceFrom = this.sourceFrom;
    if (controller && sourceFrom !== null) {
      return new Promise<boolean>((resolve, reject) => {
        controller.preserveLayoutChange({
          element: container,
          from: sourceFrom,
          to: sourceFrom
        }, () => {
          try {
            resolve(apply());
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    const projected = apply();
    view.requestMeasure();
    return projected;
  }

  fallbackText(): string {
    return `![${this.altText}](${this.url})`;
  }

  createImageControls(img: HTMLImageElement): HTMLElement {
    const strings = getUiStrings(this.uiLanguage);
    const controls = document.createElement('div');
    controls.className = 'meo-visual-controls meo-md-image-controls';

    if (this.linkUrl) {
      const isDocumentFragment = this.linkUrl.startsWith('#');
      const openLink = document.createElement('button');
      openLink.type = 'button';
      openLink.className = 'meo-visual-control-btn meo-md-image-control-btn';
      openLink.title = isDocumentFragment ? strings.jumpWithinDocument : strings.openLink;
      openLink.setAttribute('aria-label', openLink.title);
      openLink.appendChild(createElement(isDocumentFragment ? SquareArrowRightEnter : ExternalLink, { width: 16, height: 16 }));
      openLink.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openLinkedImage(openLink);
      });
      controls.appendChild(openLink);
    }

    const openExternally = document.createElement('button');
    openExternally.type = 'button';
    openExternally.className = 'meo-visual-control-btn meo-md-image-control-btn';
    openExternally.title = strings.openWithSystemApp;
    openExternally.setAttribute('aria-label', strings.openWithSystemApp);
    openExternally.appendChild(createElement(AppWindow, { width: 16, height: 16 }));
    openExternally.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openImageExternally(this.url);
    });

    const fullscreen = document.createElement('button');
    fullscreen.type = 'button';
    fullscreen.className = 'meo-visual-control-btn meo-md-image-control-btn';
    fullscreen.title = strings.fullscreenImage;
    fullscreen.setAttribute('aria-label', strings.fullscreenImage);
    fullscreen.appendChild(createElement(Maximize2, { width: 16, height: 16 }));
    fullscreen.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openFullscreen(img.currentSrc || img.src);
    });

    controls.append(openExternally, fullscreen);
    return controls;
  }

  openFullscreen(src: string): void {
    if (!src || this.fullscreenOverlay) return;
    clearPendingImageDoubleClick();

    const overlay = document.createElement('div');
    overlay.className = 'meo-md-image-fullscreen-scrim';
    const viewer = document.createElement('div');
    viewer.className = 'meo-md-image-fullscreen';
    const image = document.createElement('img');
    image.className = 'meo-md-image-fullscreen-img';
    image.alt = this.altText;
    image.src = src;
    viewer.appendChild(image);

    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let dragging = false;
    let dragged = false;
    let closeOnClick = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    const applyTransform = () => {
      image.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    };
    const changeZoom = (delta: number) => {
      zoom = Math.min(4, Math.max(0.25, zoom + delta));
      applyTransform();
    };

    const controls = document.createElement('div');
    controls.className = 'meo-visual-controls meo-md-image-fullscreen-controls';
    const addButton = (icon: typeof ZoomIn, label: string, action: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'meo-visual-control-btn meo-md-image-control-btn';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.appendChild(createElement(icon, { width: 16, height: 16 }));
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      controls.appendChild(button);
    };
    const strings = getUiStrings(this.uiLanguage);
    addButton(ZoomIn, strings.zoomIn, () => changeZoom(0.5));
    addButton(ZoomOut, strings.zoomOut, () => changeZoom(-0.5));
    addButton(RotateCcw, strings.resetZoom, () => {
      zoom = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    });
    addButton(AppWindow, strings.openWithSystemApp, () => openImageExternally(this.url));
    addButton(X, strings.exitFullscreen, () => this.closeFullscreen());
    viewer.appendChild(controls);

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.meo-md-image-fullscreen-controls'))) return;
      dragging = true;
      dragged = false;
      closeOnClick = false;
      startX = event.clientX;
      startY = event.clientY;
      lastX = event.clientX;
      lastY = event.clientY;
      viewer.setPointerCapture(event.pointerId);
      viewer.classList.add('is-dragging');
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const deltaX = event.clientX - lastX;
      const deltaY = event.clientY - lastY;
      if (Math.abs(event.clientX - startX) > 3 || Math.abs(event.clientY - startY) > 3) dragged = true;
      panX += deltaX;
      panY += deltaY;
      lastX = event.clientX;
      lastY = event.clientY;
      applyTransform();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) return;
      closeOnClick = !dragged;
      dragging = false;
      viewer.classList.remove('is-dragging');
      if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId);
    };
    const onPointerCancel = (event: PointerEvent) => {
      dragging = false;
      viewer.classList.remove('is-dragging');
      if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId);
    };
    const onClick = (event: MouseEvent) => {
      if (!closeOnClick || (event.target instanceof Element && event.target.closest('.meo-md-image-fullscreen-controls'))) return;
      closeOnClick = false;
      this.closeFullscreen();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      changeZoom(event.deltaY > 0 ? -0.25 : 0.25);
    };

    viewer.addEventListener('pointerdown', onPointerDown);
    viewer.addEventListener('pointermove', onPointerMove);
    viewer.addEventListener('pointerup', onPointerUp);
    viewer.addEventListener('pointercancel', onPointerCancel);
    viewer.addEventListener('click', onClick);
    viewer.addEventListener('wheel', onWheel, { passive: false });
    overlay.appendChild(viewer);
    document.body.appendChild(overlay);

    this.fullscreenOverlay = overlay;
    this.exitFullscreenHandler = (event) => {
      if (event.key === 'Escape') this.closeFullscreen();
    };
    document.addEventListener('keydown', this.exitFullscreenHandler);
    this.fullscreenCleanup = () => {
      viewer.removeEventListener('pointerdown', onPointerDown);
      viewer.removeEventListener('pointermove', onPointerMove);
      viewer.removeEventListener('pointerup', onPointerUp);
      viewer.removeEventListener('pointercancel', onPointerCancel);
      viewer.removeEventListener('click', onClick);
      viewer.removeEventListener('wheel', onWheel);
    };
  }

  closeFullscreen(): void {
    clearPendingImageDoubleClick();
    this.fullscreenCleanup?.();
    this.fullscreenCleanup = null;
    this.fullscreenOverlay?.remove();
    this.fullscreenOverlay = null;
    if (this.exitFullscreenHandler) {
      document.removeEventListener('keydown', this.exitFullscreenHandler);
      this.exitFullscreenHandler = null;
    }
  }

  renderFallback(container: HTMLElement): void {
    container.classList.add('meo-md-image-fallback');
    const fallback = document.createElement('code');
    fallback.className = 'meo-md-image-fallback-text';
    fallback.textContent = `![${this.altText}](${this.url})`;
    container.replaceChildren(fallback);
  }

  ignoreEvent(event: Event): boolean {
    if (event.type.startsWith('pointer') || event.type.startsWith('mouse')) {
      return false;
    }
    return true;
  }

  destroy(): void {
    this.presentationHandle?.dispose();
    this.presentationHandle = null;
    this.closeFullscreen();
  }
}

/** Disposes nested image projections before an owning widget replaces their DOM. */
export function disposeImagePresentations(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLElement>('.meo-md-image')) {
    image.dispatchEvent(new Event(IMAGE_PRESENTATION_DISPOSE_EVENT));
  }
}

export interface ImageGroupItem {
  url: string;
  altText: string;
  linkUrl: string;
  sourceFrom: number;
}

export class ImageGroupWidget extends WidgetType {
  readonly items: readonly ImageGroupItem[];
  private readonly widgets: ImageWidget[];

  constructor(
    items: readonly ImageGroupItem[],
    presentationFactory: ImagePresentationFactory,
    uiLanguage: UiLanguage = 'en'
  ) {
    super();
    this.items = items.map((item) => ({ ...item }));
    this.widgets = this.items.map((item) => new ImageWidget(
      item.url,
      item.altText,
      item.linkUrl,
      item.sourceFrom,
      presentationFactory,
      { uiLanguage }
    ));
  }

  eq(other: ImageGroupWidget): boolean {
    return (
      other instanceof ImageGroupWidget
      && other.items.length === this.items.length
      && other.items.every((item, index) => {
        const current = this.items[index];
        return (
          item.url === current.url
          && item.altText === current.altText
          && item.linkUrl === current.linkUrl
          && item.sourceFrom === current.sourceFrom
        );
      })
    );
  }

  toDOM(view?: EditorView): HTMLElement {
    const group = document.createElement('div');
    group.className = 'meo-md-image-group';
    group.append(...this.widgets.map((widget) => widget.toDOM(view)));
    return group;
  }

  ignoreEvent(event: Event): boolean {
    if (event.type.startsWith('pointer') || event.type.startsWith('mouse')) {
      return false;
    }
    return true;
  }

  destroy(): void {
    for (const widget of this.widgets) widget.destroy();
  }
}

function findChildNode(node: any, name: string): any {
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

function stripMarkdownImageTitle(url: string): string {
  const title = /^(.*?)\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))\s*$/.exec(url);
  return (title?.[1] ?? url).trim();
}

export function getImageData(state: any, node: any): { url: string; altText: string; linkUrl: string } {
  const urlNode = findChildNode(node, 'URL');
  const rawUrl = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to).trim() : '';
  const url = stripMarkdownImageTitle(rawUrl);

  let altText = '';
  const imageText = state.doc.sliceString(node.from, node.to);
  const altMatch = /!\[([^\]]*)\]/.exec(imageText);
  if (altMatch) {
    altText = altMatch[1];
  }

  let linkUrl = '';
  const parentNode = node.node.parent;
  if (parentNode && parentNode.name === 'Link') {
    const linkUrlNode = findChildNode(parentNode, 'URL');
    if (linkUrlNode) {
      linkUrl = state.doc.sliceString(linkUrlNode.from, linkUrlNode.to).trim();
    }
  }

  return { url, altText, linkUrl };
}
