import { createElement, Moon, Sun } from 'lucide';
import { getExportStyleEnvironment } from './export';
import type { OutlineHeading } from './outline';
import type { PreviewAppearance, PreviewRenderErrorMessage, PreviewRenderedMessage } from '../../../src/shared/preview';

type PreviewControllerOptions = {
  vscode: { postMessage: (message: WebviewMessage) => void };
  onRendered?: () => void;
};

let mermaidRuntimePromise: Promise<any> | null = null;

export function createPreviewController({ vscode, onRendered }: PreviewControllerOptions) {
  const host = document.createElement('div');
  host.className = 'preview-host';
  host.hidden = true;

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = 'Markdown Preview';
  frame.setAttribute('sandbox', 'allow-same-origin');

  const themeToggle = document.createElement('button');
  themeToggle.type = 'button';
  themeToggle.className = 'preview-theme-toggle';

  const status = document.createElement('div');
  status.className = 'preview-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  host.append(frame, themeToggle, status);

  let appearance: PreviewAppearance = 'dark';
  let requestCounter = 0;
  let pendingRequestId = '';
  let pendingRestoreLine: number | null = null;
  let latestPayload: PreviewRenderedMessage | null = null;

  const updateThemeToggle = () => {
    const switchToLight = appearance === 'dark';
    themeToggle.replaceChildren(createElement(switchToLight ? Sun : Moon, {
      width: 17,
      height: 17,
      'aria-hidden': 'true'
    }));
    themeToggle.title = switchToLight ? '切换为白色背景' : '切换为暗色背景';
    themeToggle.setAttribute('aria-label', themeToggle.title);
    themeToggle.setAttribute('aria-pressed', appearance === 'light' ? 'true' : 'false');
  };

  const setStatus = (message: string | null) => {
    status.hidden = !message;
    status.textContent = message ?? '';
  };

  const renderFrame = (preserveScroll = false, restoreLine: number | null = null) => {
    if (!latestPayload) {
      return;
    }
    const previousScrollTop = preserveScroll
      ? Number(frame.contentDocument?.scrollingElement?.scrollTop ?? 0)
      : 0;
    const katexHref = document.body.dataset.meoKatexSrc ?? '';
    const katexLink = katexHref
      ? `<link rel="stylesheet" href="${escapeHtmlAttribute(katexHref)}">`
      : '';
    const styles = latestPayload.styles[appearance].replace(/<\/style/gi, '<\\/style');
    frame.onload = () => {
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }
      const scrollElement = frameDocument.scrollingElement;
      if (scrollElement) {
        scrollElement.scrollTop = previousScrollTop;
      }
      if (!preserveScroll && restoreLine !== null) {
        restoreTopLine(restoreLine);
      }
      bindPreviewLinks(frameDocument, vscode);
      const finishRender = () => {
        // Mermaid replaces placeholders asynchronously, so restore again after its layout settles.
        if (!preserveScroll && restoreLine !== null) {
          restoreTopLine(restoreLine);
        }
        onRendered?.();
      };
      if (latestPayload?.hasMermaid) {
        void renderMermaidBlocks(frameDocument, appearance).finally(finishRender);
      } else {
        finishRender();
      }
    };
    frame.srcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexLink}<style>${styles}</style></head><body><div class="meo-export-page"><main class="meo-export-doc">${latestPayload.html}</main></div></body></html>`;
  };

  const requestRender = (text: string, { restoreLine = null }: { restoreLine?: number | null } = {}) => {
    const requestId = `preview-${Date.now()}-${requestCounter += 1}`;
    pendingRequestId = requestId;
    pendingRestoreLine = restoreLine;
    setStatus('正在生成预览…');
    vscode.postMessage({
      type: 'requestPreviewRender',
      requestId,
      text,
      environment: getExportStyleEnvironment()
    });
  };

  const handleRendered = (message: PreviewRenderedMessage) => {
    if (message.requestId !== pendingRequestId) {
      return;
    }
    latestPayload = message;
    setStatus(null);
    const restoreLine = pendingRestoreLine;
    pendingRestoreLine = null;
    renderFrame(false, restoreLine);
  };

  const handleRenderError = (message: PreviewRenderErrorMessage) => {
    if (message.requestId === pendingRequestId) {
      setStatus(message.message || 'Preview 生成失败');
    }
  };

  themeToggle.addEventListener('click', () => {
    appearance = appearance === 'dark' ? 'light' : 'dark';
    updateThemeToggle();
    renderFrame(true);
  });
  updateThemeToggle();

  const getFrameDocument = () => frame.contentDocument;
  const getSourceElements = (): HTMLElement[] => Array.from(
    getFrameDocument()?.querySelectorAll<HTMLElement>('[data-source-line]') ?? []
  );
  const getSourceRange = (element: HTMLElement): { start: number; end: number } | null => {
    const start = Number.parseInt(element.dataset.sourceLine ?? '', 10);
    if (!Number.isFinite(start)) {
      return null;
    }
    const parsedEnd = Number.parseInt(element.dataset.sourceEndLine ?? '', 10);
    return { start, end: Number.isFinite(parsedEnd) ? Math.max(start, parsedEnd) : start };
  };
  const findSourceElement = (line: number): { element: HTMLElement; start: number; end: number } | null => {
    let candidate: HTMLElement | null = null;
    for (const element of getSourceElements()) {
      const range = getSourceRange(element);
      if (!range) {
        continue;
      }
      if (line >= range.start && line <= range.end) {
        return { element, ...range };
      }
      if (range.start > line) {
        const fallback = candidate ?? element;
        const fallbackRange = getSourceRange(fallback)!;
        return { element: fallback, ...fallbackRange };
      }
      candidate = element;
    }
    if (!candidate) {
      return null;
    }
    const range = getSourceRange(candidate)!;
    return { element: candidate, ...range };
  };
  const restoreTopLine = (line: number): void => {
    const source = findSourceElement(line);
    const scrollElement = getFrameDocument()?.scrollingElement;
    if (!source || !scrollElement) {
      return;
    }
    const lineSpan = Math.max(1, source.end - source.start + 1);
    const ratio = Math.max(0, Math.min(1, (line - source.start) / lineSpan));
    const rect = source.element.getBoundingClientRect();
    scrollElement.scrollTop += rect.top + rect.height * ratio;
  };
  const getTopVisiblePosition = (): { topLine: number; topLineOffset: number } | null => {
    const elements = getSourceElements();
    if (elements.length === 0) {
      return null;
    }
    const viewportAnchor = 8;
    let candidate = elements[0];
    for (const element of elements) {
      if (element.getBoundingClientRect().top > viewportAnchor) {
        break;
      }
      candidate = element;
    }
    const range = getSourceRange(candidate);
    if (!range) {
      return null;
    }
    const rect = candidate.getBoundingClientRect();
    const ratio = rect.height > 0 ? Math.max(0, Math.min(1, (viewportAnchor - rect.top) / rect.height)) : 0;
    const topLine = Math.round(range.start + (range.end - range.start) * ratio);
    return { topLine, topLineOffset: 0 };
  };
  const getHeadings = (): OutlineHeading[] => {
    const headingElements = Array.from(
      getFrameDocument()?.querySelectorAll<HTMLElement>('h1[data-source-line], h2[data-source-line], h3[data-source-line], h4[data-source-line], h5[data-source-line], h6[data-source-line]') ?? []
    );
    return headingElements.map((heading) => {
      const line = Number.parseInt(heading.dataset.sourceLine ?? '1', 10);
      return {
        text: heading.textContent?.trim() || 'Untitled',
        level: Number.parseInt(heading.tagName.slice(1), 10),
        from: line,
        line
      };
    });
  };

  const getVisibleDocumentRange = () => {
    const headings = getHeadings();
    const viewportHeight = frame.contentWindow?.innerHeight ?? host.clientHeight;
    const elements = getSourceElements();
    const visibleLines = elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom >= 0 && rect.top <= viewportHeight;
      })
      .map((element) => Number.parseInt(element.dataset.sourceLine ?? '1', 10))
      .filter(Number.isFinite);
    const fallbackLastLine = headings.at(-1)?.line ?? 1;
    const fromLine = visibleLines.length > 0 ? Math.min(...visibleLines) : 1;
    const toLine = visibleLines.length > 0 ? Math.max(...visibleLines) : fallbackLastLine;
    return { from: fromLine, to: toLine, fromLine, toLine };
  };

  const outlineAdapter = {
    getHeadings,
    getViewportAnchorOffset: (ratio = 0.2) => {
      const anchorY = (frame.contentWindow?.innerHeight ?? host.clientHeight) * ratio;
      let activeLine = 1;
      for (const heading of getSourceElements()) {
        if (heading.getBoundingClientRect().top > anchorY) {
          break;
        }
        activeLine = Number.parseInt(heading.dataset.sourceLine ?? '1', 10);
      }
      return activeLine;
    },
    getVisibleDocumentRange,
    getScrollElement: () => getFrameDocument() ?? frame,
    scrollToLine: (line: number) => {
      getFrameDocument()?.querySelector<HTMLElement>(`[data-source-line="${line}"]`)?.scrollIntoView({ block: 'start' });
    },
    moveHeadingSection: () => false
  };

  return {
    host,
    requestRender,
    handleRendered,
    handleRenderError,
    resetAppearance: () => {
      appearance = 'dark';
      updateThemeToggle();
    },
    setVisible: (visible: boolean) => {
      host.hidden = !visible;
    },
    getTopVisiblePosition,
    restoreTopLine,
    getOutlineAdapter: () => outlineAdapter
  };
}

function bindPreviewLinks(
  frameDocument: Document,
  vscode: { postMessage: (message: WebviewMessage) => void }
): void {
  frameDocument.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!target) {
      return;
    }
    const href = target.getAttribute('href')?.trim() ?? '';
    if (!href || href.startsWith('#')) {
      return;
    }
    event.preventDefault();
    vscode.postMessage({ type: 'openLink', href });
  });
}

async function renderMermaidBlocks(frameDocument: Document, appearance: PreviewAppearance): Promise<void> {
  const blocks = Array.from(frameDocument.querySelectorAll<HTMLElement>('.meo-export-mermaid[data-source-b64]'));
  if (blocks.length === 0) {
    return;
  }
  const mermaid = await ensureMermaidRuntime();
  const frameStyles = frameDocument.defaultView?.getComputedStyle(frameDocument.documentElement);
  const readColor = (name: string, fallback: string) => frameStyles?.getPropertyValue(name).trim() || fallback;
  const background = readColor('--meo-bg', appearance === 'dark' ? '#20252b' : '#ffffff');
  const panelBackground = readColor('--meo-code-bg', background);
  const foreground = readColor('--meo-fg', appearance === 'dark' ? '#d8dee9' : '#1f2328');
  const muted = readColor('--meo-muted', appearance === 'dark' ? '#9aa4af' : '#59636e');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      background,
      mainBkg: panelBackground,
      secondBkg: panelBackground,
      tertiaryColor: panelBackground,
      primaryColor: panelBackground,
      primaryTextColor: foreground,
      primaryBorderColor: muted,
      nodeBorder: muted,
      lineColor: muted,
      textColor: foreground,
      nodeTextColor: foreground,
      edgeLabelBackground: background,
      clusterBkg: background,
      clusterBorder: muted,
      titleColor: foreground,
      darkMode: appearance === 'dark'
    }
  });
  let index = 0;
  for (const block of blocks) {
    const source = decodeBase64Utf8(block.dataset.sourceB64 ?? '');
    if (!source) {
      continue;
    }
    try {
      const result = await mermaid.render(`meo-preview-mermaid-${Date.now()}-${index += 1}`, source);
      const svg = typeof result === 'string' ? result : result?.svg;
      if (svg) {
        block.classList.add('is-rendered');
        block.innerHTML = `<div class="meo-export-mermaid-svg">${svg}</div>`;
      }
    } catch {
      block.classList.add('is-error');
    }
  }
}

function ensureMermaidRuntime(): Promise<any> {
  const existing = (globalThis as any).mermaid;
  if (existing) {
    return Promise.resolve(existing);
  }
  if (mermaidRuntimePromise) {
    return mermaidRuntimePromise;
  }
  mermaidRuntimePromise = new Promise((resolve, reject) => {
    const src = document.body.dataset.meoMermaidSrc;
    if (!src) {
      reject(new Error('Mermaid runtime is unavailable'));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.addEventListener('load', () => resolve((globalThis as any).mermaid), { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load Mermaid runtime')), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    mermaidRuntimePromise = null;
    throw error;
  });
  return mermaidRuntimePromise;
}

function decodeBase64Utf8(value: string): string {
  try {
    const binary = window.atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return '';
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
