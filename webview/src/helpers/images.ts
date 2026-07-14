import { EditorView, WidgetType } from '@codemirror/view';
import { AppWindow, CornerDownRight, createElement, ExternalLink, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide';
import { beginViewportAnchor, canApplyViewportAnchor, hasRecentViewportInteraction } from './viewportStability';

const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;

let imageSrcResolver: (url: string) => string | Promise<string | null | undefined> | null | undefined = (url) => url;
let vscodeApi: any = null;

const MAX_IMAGE_SRC_CACHE_ENTRIES = 512;
const MAX_LOADED_IMAGE_CACHE_ENTRIES = 128;
const MAX_FAILED_IMAGE_CACHE_ENTRIES = 256;
const MAX_CONCURRENT_IMAGE_LOADS = 6;
const IMAGE_FAILURE_RETRY_MS = 30_000;

const imageSrcCache = new Map<string, string>();
const loadedImages = new Map<string, HTMLImageElement>();
const pendingImageLoads = new Map<string, Promise<HTMLImageElement | null>>();
const failedImages = new Map<string, number>();
const queuedImageLoads: Array<() => void> = [];
let activeImageLoads = 0;
const pendingImageResolvers = new Map<string, ((value: string) => void)[]>();
const imageRequestById = new Map<string, string>();
let imageRequestCounter = 0;
const IMAGE_DOUBLE_CLICK_WINDOW_MS = 400;
const IMAGE_DOUBLE_CLICK_MAX_DISTANCE_PX = 8;
type ImageDoubleClickCandidate = {
  x: number;
  y: number;
  openFullscreen: () => void;
  timeout: number;
};
let pendingImageDoubleClick: ImageDoubleClickCandidate | null = null;
let imageDoubleClickListenerInitialized = false;

let imageSaveRequestCounter = 0;
const pendingImageSaveRequests = new Map<string, {
  resolve: (value: { success: boolean; path?: string; error?: string }) => void;
  timeout: number;
}>();
const IMAGE_SAVE_TIMEOUT_MS = 15_000;

function touchCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  touchCacheEntry(cache, key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function getLoadedImage(url: string): HTMLImageElement | undefined {
  const image = loadedImages.get(url);
  if (image) touchCacheEntry(loadedImages, url, image);
  return image;
}

function hasRecentImageFailure(url: string): boolean {
  const failedAt = failedImages.get(url);
  if (failedAt === undefined) return false;
  if (Date.now() - failedAt < IMAGE_FAILURE_RETRY_MS) return true;
  failedImages.delete(url);
  return false;
}

function scheduleImageLoad<T>(load: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeImageLoads += 1;
      load().then(resolve, reject).finally(() => {
        activeImageLoads -= 1;
        queuedImageLoads.shift()?.();
      });
    };
    if (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS) run();
    else queuedImageLoads.push(run);
  });
}

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

const requestImageSrcResolution = (url: string): Promise<string> => new Promise((resolve) => {
  const waiting = pendingImageResolvers.get(url);
  if (waiting) {
    waiting.push(resolve);
    return;
  }

  pendingImageResolvers.set(url, [resolve]);
  const requestId = `img-${imageRequestCounter++}`;
  imageRequestById.set(requestId, url);
  vscodeApi?.postMessage({ type: 'resolveImageSrc', requestId, url });
});

export const settleImageSrcRequest = (requestId: string, resolvedUrl: string | undefined): void => {
  const rawUrl = imageRequestById.get(requestId);
  if (typeof rawUrl !== 'string') {
    return;
  }

  imageRequestById.delete(requestId);
  const finalUrl = resolvedUrl || rawUrl;
  if (resolvedUrl) {
    setBoundedCacheEntry(imageSrcCache, rawUrl, resolvedUrl, MAX_IMAGE_SRC_CACHE_ENTRIES);
  }
  const waiters = pendingImageResolvers.get(rawUrl) ?? [];
  pendingImageResolvers.delete(rawUrl);
  for (const resolve of waiters) {
    resolve(finalUrl);
  }
};

export const resolveImageSrc = (rawUrl: string | null | undefined): string | Promise<string> => {
  const url = (rawUrl ?? '').trim();
  if (!url || isImmediateImageSrc(url)) {
    return url;
  }
  const cached = imageSrcCache.get(url);
  if (typeof cached === 'string') {
    touchCacheEntry(imageSrcCache, url, cached);
    return cached;
  }
  return requestImageSrcResolution(url);
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

export const handleSavedImagePath = (message: { requestId: string; success?: boolean; path?: string; error?: string }): void => {
  const pending = pendingImageSaveRequests.get(message.requestId);
  if (pending) {
    pendingImageSaveRequests.delete(message.requestId);
    window.clearTimeout(pending.timeout);
    if (message.success && message.path) {
      pending.resolve({ success: true, path: message.path });
    } else {
      pending.resolve({ success: false, error: message.error ?? 'Failed to save image' });
    }
  }
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

    const requestId = `img-save-${imageSaveRequestCounter++}`;
    const timestamp = Date.now();
    const dataUrlMimeType = parseDataUrlMimeType(imageData);
    const extension = (
      imageExtensionFromMimeType(dataUrlMimeType) ||
      imageExtensionFromMimeType(mimeType) ||
      'png'
    );
    const fileName = `${timestamp}.${extension}`;

    const promise = new Promise<{ success: boolean; path?: string; error?: string }>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingImageSaveRequests.delete(requestId);
        resolve({ success: false, error: 'Timed out while saving pasted image' });
      }, IMAGE_SAVE_TIMEOUT_MS);
      pendingImageSaveRequests.set(requestId, { resolve, timeout });
    });

    vscodeApi?.postMessage({
      type: 'saveImageFromClipboard',
      requestId,
      imageData,
      fileName
    });

    try {
      const result = await promise;
      if (result.success && result.path) {
        const imageMarkdown = `![${fileName}](${result.path})`;
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
        context.onError?.(result.error ?? 'Failed to save pasted image');
      }
    } catch (error) {
      console.error('[MEO image paste]', error);
      context.onError?.(error instanceof Error ? error.message : 'Failed to paste image');
    }

    return true;
  }

  return false;
};

export function setImageSrcResolver(resolver: (url: string) => string | Promise<string | null | undefined> | null | undefined): void {
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
  fullscreenOverlay: HTMLElement | null;
  fullscreenCleanup: (() => void) | null;
  exitFullscreenHandler: ((event: KeyboardEvent) => void) | null;

  constructor(
    url: string | null | undefined,
    altText: string | null | undefined,
    linkUrl: string | null | undefined,
    sourceFrom: number | null = null
  ) {
    super();
    this.url = url?.trim() ?? '';
    this.altText = altText ?? '';
    this.linkUrl = linkUrl?.trim() ?? '';
    this.sourceFrom = Number.isInteger(sourceFrom) ? sourceFrom : null;
    this.fullscreenOverlay = null;
    this.fullscreenCleanup = null;
    this.exitFullscreenHandler = null;
    if (this.url) {
      void this.preloadImage();
    }
  }

  eq(other: ImageWidget): boolean {
    return (
      other instanceof ImageWidget &&
      other.url === this.url &&
      other.altText === this.altText &&
      other.linkUrl === this.linkUrl &&
      other.sourceFrom === this.sourceFrom
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
    this.attachImagePointerInteractions(container);

    const cachedImage = getLoadedImage(this.url);
    if (cachedImage) {
      const img = this.createDisplayImage(cachedImage);
      container.append(img, this.createImageControls(img));
      return container;
    }

    this.renderFallback(container);
    if (!hasRecentImageFailure(this.url)) {
      void this.preloadImage().then((image) => {
        if (image) {
          this.showLoadedImage(container, this.createDisplayImage(image), view);
        }
      });
    }
    return container;
  }

  createLoadedImage(src: string): HTMLImageElement {
    const img = document.createElement('img');
    img.className = 'meo-md-image-img';
    img.alt = this.altText;
    img.loading = 'eager';
    img.src = src;
    return img;
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

  preloadImage(): Promise<HTMLImageElement | null> {
    const cachedImage = getLoadedImage(this.url);
    if (cachedImage) return Promise.resolve(cachedImage);

    const pendingLoad = pendingImageLoads.get(this.url);
    if (pendingLoad) return pendingLoad;

    const load = scheduleImageLoad(() => new Promise<HTMLImageElement | null>((resolve) => {
      this.setImageSource((src) => {
        const img = this.createLoadedImage(src);
        let settled = false;
        const succeed = () => {
          if (settled) return;
          settled = true;
          setBoundedCacheEntry(loadedImages, this.url, img, MAX_LOADED_IMAGE_CACHE_ENTRIES);
          failedImages.delete(this.url);
          resolve(img);
        };
        const fail = () => {
          if (settled) return;
          settled = true;
          setBoundedCacheEntry(failedImages, this.url, Date.now(), MAX_FAILED_IMAGE_CACHE_ENTRIES);
          resolve(null);
        };

        img.addEventListener('load', succeed, { once: true });
        img.addEventListener('error', fail, { once: true });
        if (img.complete && img.naturalWidth > 0) {
          succeed();
        }
      }, () => {
        setBoundedCacheEntry(failedImages, this.url, Date.now(), MAX_FAILED_IMAGE_CACHE_ENTRIES);
        resolve(null);
      });
    })).finally(() => {
      pendingImageLoads.delete(this.url);
    });
    pendingImageLoads.set(this.url, load);
    return load;
  }

  showLoadedImage(container: HTMLElement, img: HTMLImageElement, view?: EditorView): void {
    const show = () => {
      container.classList.remove('meo-md-image-fallback');
      container.replaceChildren(img, this.createImageControls(img));
    };
    if (!view || !container.isConnected) {
      show();
      return;
    }

    view.requestMeasure({
      read(editorView) {
        const scrollerRect = editorView.scrollDOM.getBoundingClientRect();
        const imageRect = container.getBoundingClientRect();
        if (imageRect.top >= scrollerRect.top) return null;
        const anchor = Array.from(editorView.contentDOM.querySelectorAll('.cm-line'))
          .find((line) => line.getBoundingClientRect().top >= scrollerRect.top) as HTMLElement | undefined;
        return anchor ? { anchor, top: anchor.getBoundingClientRect().top } : null;
      },
      write: (anchor) => {
        show();
        if (!anchor) {
          view.requestMeasure();
          return;
        }
        this.keepViewportAnchor(view, anchor);
      },
    });
  }

  createImageControls(img: HTMLImageElement): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'meo-md-image-controls';

    if (this.linkUrl) {
      const isDocumentFragment = this.linkUrl.startsWith('#');
      const openLink = document.createElement('button');
      openLink.type = 'button';
      openLink.className = 'meo-md-image-control-btn';
      openLink.title = isDocumentFragment ? 'Jump within document' : 'Open link';
      openLink.setAttribute('aria-label', openLink.title);
      openLink.appendChild(createElement(isDocumentFragment ? CornerDownRight : ExternalLink, { width: 16, height: 16 }));
      openLink.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openLinkedImage(openLink);
      });
      controls.appendChild(openLink);
    }

    const openExternally = document.createElement('button');
    openExternally.type = 'button';
    openExternally.className = 'meo-md-image-control-btn';
    openExternally.title = 'Open with system app';
    openExternally.setAttribute('aria-label', 'Open with system app');
    openExternally.appendChild(createElement(AppWindow, { width: 16, height: 16 }));
    openExternally.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openImageExternally(this.url);
    });

    const fullscreen = document.createElement('button');
    fullscreen.type = 'button';
    fullscreen.className = 'meo-md-image-control-btn';
    fullscreen.title = 'Fullscreen image';
    fullscreen.setAttribute('aria-label', 'Fullscreen image');
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
    controls.className = 'meo-md-image-fullscreen-controls';
    const addButton = (icon: typeof ZoomIn, label: string, action: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'meo-md-image-control-btn';
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
    addButton(ZoomIn, 'Zoom in', () => changeZoom(0.5));
    addButton(ZoomOut, 'Zoom out', () => changeZoom(-0.5));
    addButton(RotateCcw, 'Reset zoom', () => {
      zoom = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    });
    addButton(AppWindow, 'Open with system app', () => openImageExternally(this.url));
    addButton(X, 'Exit fullscreen', () => this.closeFullscreen());
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

  keepViewportAnchor(view: EditorView, anchor: { anchor: HTMLElement; top: number }): void {
    if (hasRecentViewportInteraction(view)) return;
    const anchorGeneration = beginViewportAnchor(view);
    let remainingFrames = 3;
    let expectedScrollTop = view.scrollDOM.scrollTop;
    const measure = () => {
      view.requestMeasure({
        read() {
          if (!anchor.anchor.isConnected || !canApplyViewportAnchor(view, anchorGeneration)) return null;
          return {
            delta: anchor.anchor.getBoundingClientRect().top - anchor.top,
            scrollTop: view.scrollDOM.scrollTop,
          };
        },
        write(measurement) {
          if (!measurement || !canApplyViewportAnchor(view, anchorGeneration)) return;
          const { delta, scrollTop } = measurement;
          if (
            Math.abs(scrollTop - expectedScrollTop) > 0.5
            || Math.abs(view.scrollDOM.scrollTop - scrollTop) > 0.5
          ) {
            return;
          }
          if (Math.abs(delta) > 0.5) {
            view.scrollDOM.scrollTop += delta;
          }
          expectedScrollTop = view.scrollDOM.scrollTop;
          remainingFrames -= 1;
          if (remainingFrames > 0) {
            requestAnimationFrame(measure);
          }
        },
      });
    };
    measure();
  }

  renderFallback(container: HTMLElement): void {
    container.classList.add('meo-md-image-fallback');
    const fallback = document.createElement('code');
    fallback.className = 'meo-md-image-fallback-text';
    fallback.textContent = `![${this.altText}](${this.url})`;
    container.replaceChildren(fallback);
  }

  setImageSource(onSrc: (src: string) => void, onFail: () => void): void {
    const resolved = imageSrcResolver(this.url);
    if (isPromiseLike(resolved)) {
      resolved.then((value) => {
        if (!value) {
          onFail();
          return;
        }
        onSrc(value);
      }).catch(onFail);
      return;
    }

    if (!resolved) {
      onFail();
      return;
    }

    onSrc(resolved);
  }

  ignoreEvent(event: Event): boolean {
    if (event.type.startsWith('pointer') || event.type.startsWith('mouse')) {
      return false;
    }
    return true;
  }

  destroy(): void {
    this.closeFullscreen();
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

  constructor(items: readonly ImageGroupItem[]) {
    super();
    this.items = items.map((item) => ({ ...item }));
    this.widgets = this.items.map((item) => new ImageWidget(
      item.url,
      item.altText,
      item.linkUrl,
      item.sourceFrom
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

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as any).then === 'function';
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
