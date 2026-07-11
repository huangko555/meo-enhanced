import { EditorView, WidgetType } from '@codemirror/view';
import { createElement, ExternalLink, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide';

const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;

let imageSrcResolver: (url: string) => string | Promise<string | null | undefined> | null | undefined = (url) => url;
let vscodeApi: any = null;

const imageSrcCache = new Map<string, string>();
const loadedImages = new Map<string, HTMLImageElement>();
const pendingImageLoads = new Map<string, Promise<HTMLImageElement | null>>();
const failedImages = new Set<string>();
const pendingImageResolvers = new Map<string, ((value: string) => void)[]>();
const imageRequestById = new Map<string, string>();
let imageRequestCounter = 0;

let imageSaveRequestCounter = 0;
const pendingImageSaveRequests = new Map<string, {
  resolve: (value: { success: boolean; path?: string; error?: string }) => void;
}>();

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
  imageSrcCache.set(rawUrl, finalUrl);
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
}

export const handleImagePaste = async (
  event: ClipboardEvent,
  editor: any,
  context: ImagePasteContext
): Promise<boolean> => {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return false;
  }

  for (const item of clipboardItems) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    event.preventDefault();
    event.stopPropagation();

    const blob = item.getAsFile();
    if (!blob) {
      continue;
    }

    const imageData = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read pasted image'));
      reader.readAsDataURL(blob);
    });

    if (!imageData) {
      return true;
    }

    const requestId = `img-save-${imageSaveRequestCounter++}`;
    const timestamp = Date.now();
    const dataUrlMimeType = parseDataUrlMimeType(imageData);
    const extension = (
      imageExtensionFromMimeType(dataUrlMimeType) ||
      imageExtensionFromMimeType(item.type) ||
      'png'
    );
    const fileName = `${timestamp}.${extension}`;

    const promise = new Promise<{ success: boolean; path?: string; error?: string }>((resolve) => {
      pendingImageSaveRequests.set(requestId, { resolve });
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
        const currentState = editor.view.state;
        const targetLineNumber = Math.min(context.lineNumber, currentState.doc.lines);
        const targetLine = currentState.doc.line(targetLineNumber);
        const insertAt = Math.min(targetLine.to, targetLine.from + context.lineOffset);
        editor.view.dispatch({
          changes: { from: insertAt, to: insertAt, insert: imageMarkdown },
          selection: { anchor: insertAt + imageMarkdown.length }
        });
        editor.focus();
      }
    } catch {
      // Ignore errors - image paste failed silently
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
  fullscreenOverlay: HTMLElement | null;
  fullscreenCleanup: (() => void) | null;
  exitFullscreenHandler: ((event: KeyboardEvent) => void) | null;

  constructor(url: string | null | undefined, altText: string | null | undefined, linkUrl: string | null | undefined) {
    super();
    this.url = url?.trim() ?? '';
    this.altText = altText ?? '';
    this.linkUrl = linkUrl?.trim() ?? '';
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
      other.linkUrl === this.linkUrl
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

    const cachedImage = loadedImages.get(this.url);
    if (cachedImage) {
      const img = this.createDisplayImage(cachedImage);
      container.append(img, this.createImageControls(img));
      return container;
    }

    this.renderFallback(container);
    if (!failedImages.has(this.url)) {
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
    if (!cachedImage.isConnected) {
      cachedImage.alt = this.altText;
      return cachedImage;
    }
    return this.createLoadedImage(cachedImage.currentSrc || cachedImage.src);
  }

  preloadImage(): Promise<HTMLImageElement | null> {
    const cachedImage = loadedImages.get(this.url);
    if (cachedImage) return Promise.resolve(cachedImage);

    const pendingLoad = pendingImageLoads.get(this.url);
    if (pendingLoad) return pendingLoad;

    const load = new Promise<HTMLImageElement | null>((resolve) => {
      this.setImageSource((src) => {
        const img = this.createLoadedImage(src);
        let settled = false;
        const succeed = () => {
          if (settled) return;
          settled = true;
          loadedImages.set(this.url, img);
          failedImages.delete(this.url);
          resolve(img);
        };
        const fail = () => {
          if (settled) return;
          settled = true;
          failedImages.add(this.url);
          resolve(null);
        };

        img.addEventListener('load', succeed, { once: true });
        img.addEventListener('error', fail, { once: true });
        if (img.complete && img.naturalWidth > 0) {
          succeed();
        }
      }, () => {
        failedImages.add(this.url);
        resolve(null);
      });
    }).finally(() => {
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

    const openExternally = document.createElement('button');
    openExternally.type = 'button';
    openExternally.className = 'meo-md-image-control-btn';
    openExternally.title = 'Open with system app';
    openExternally.setAttribute('aria-label', 'Open with system app');
    openExternally.appendChild(createElement(ExternalLink, { width: 16, height: 16 }));
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
    let startedOnImage = false;
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
    addButton(ExternalLink, 'Open with system app', () => openImageExternally(this.url));
    addButton(X, 'Exit fullscreen', () => this.closeFullscreen());
    viewer.appendChild(controls);

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.meo-md-image-fullscreen-controls'))) return;
      dragging = true;
      dragged = false;
      startedOnImage = event.target === image;
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
      const shouldExit = startedOnImage && !dragged;
      dragging = false;
      viewer.classList.remove('is-dragging');
      if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId);
      if (shouldExit) this.closeFullscreen();
    };
    const onPointerCancel = (event: PointerEvent) => {
      dragging = false;
      viewer.classList.remove('is-dragging');
      if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      changeZoom(event.deltaY > 0 ? -0.25 : 0.25);
    };

    viewer.addEventListener('pointerdown', onPointerDown);
    viewer.addEventListener('pointermove', onPointerMove);
    viewer.addEventListener('pointerup', onPointerUp);
    viewer.addEventListener('pointercancel', onPointerCancel);
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
      viewer.removeEventListener('wheel', onWheel);
    };
  }

  closeFullscreen(): void {
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
    let remainingFrames = 3;
    let expectedScrollTop = view.scrollDOM.scrollTop;
    const measure = () => {
      view.requestMeasure({
        read() {
          if (!anchor.anchor.isConnected) return null;
          return {
            delta: anchor.anchor.getBoundingClientRect().top - anchor.top,
            scrollTop: view.scrollDOM.scrollTop,
          };
        },
        write(measurement) {
          if (!measurement) return;
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
