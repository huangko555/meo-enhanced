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

  const renderFrame = (preserveScroll = false) => {
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
      bindPreviewLinks(frameDocument, vscode);
      if (latestPayload?.hasMermaid) {
        void renderMermaidBlocks(frameDocument, appearance).finally(() => onRendered?.());
      } else {
        onRendered?.();
      }
    };
    frame.srcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexLink}<style>${styles}</style></head><body><div class="meo-export-page"><main class="meo-export-doc">${latestPayload.html}</main></div></body></html>`;
  };

  const requestRender = (text: string) => {
    const requestId = `preview-${Date.now()}-${requestCounter += 1}`;
    pendingRequestId = requestId;
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
    renderFrame();
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
    const elements = Array.from(getFrameDocument()?.querySelectorAll<HTMLElement>('[data-source-line]') ?? []);
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
      for (const heading of Array.from(getFrameDocument()?.querySelectorAll<HTMLElement>('[data-source-line]') ?? [])) {
        if (heading.getBoundingClientRect().top > anchorY) {
          break;
        }
        activeLine = Number.parseInt(heading.dataset.sourceLine ?? '1', 10);
      }
      return activeLine;
    },
    getVisibleDocumentRange,
    getScrollElement: () => (getFrameDocument()?.scrollingElement ?? frame) as HTMLElement,
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
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: appearance === 'dark' ? 'dark' : 'default'
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
