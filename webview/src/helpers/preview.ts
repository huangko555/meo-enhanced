import { createElement, Moon, Sun } from 'lucide';
import { getExportStyleEnvironment } from './export';
import { createPreviewMermaidRenderer } from './previewMermaid';
import { createDocumentScrollToTopController } from './scrollToTop';
import { createSegmentedControl } from './segmentedControl';
import type { OutlineHeading } from './outline';
import type { PreviewAppearance, PreviewRenderErrorMessage, PreviewRenderedMessage } from '../../../src/shared/preview';

type PreviewControllerOptions = {
  vscode: { postMessage: (message: WebviewMessage) => void };
  onRendered?: () => void;
  onFindRequested?: () => void;
};

const previewScrollbarStyles = `
html,
body {
  scrollbar-gutter: stable;
  scrollbar-color: color-mix(in srgb, var(--meo-fg) 38%, transparent) transparent;
  scrollbar-width: thin;
}

html::-webkit-scrollbar,
body::-webkit-scrollbar {
  -webkit-appearance: none;
  width: 10px !important;
  height: 10px !important;
}

html::-webkit-scrollbar-track,
body::-webkit-scrollbar-track {
  -webkit-appearance: none;
  background: transparent !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

html::-webkit-scrollbar-thumb,
body::-webkit-scrollbar-thumb {
  -webkit-appearance: none;
  background: color-mix(in srgb, var(--meo-fg) 38%, transparent) !important;
  background-clip: border-box !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

html::-webkit-scrollbar-thumb:hover,
body::-webkit-scrollbar-thumb:hover {
  -webkit-appearance: none;
  background: color-mix(in srgb, var(--meo-fg) 50%, transparent) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

html::-webkit-scrollbar-thumb:active,
body::-webkit-scrollbar-thumb:active {
  -webkit-appearance: none;
  background: color-mix(in srgb, var(--meo-fg) 62%, transparent) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

html::-webkit-scrollbar-corner,
body::-webkit-scrollbar-corner {
  background: transparent !important;
}
`;

function collectPreviewKatexStyles(katexHref: string): string {
  if (!katexHref) {
    return '';
  }

  const stylesheet = Array.from(document.styleSheets).find((sheet) => (
    sheet.href === katexHref ||
    Boolean(sheet.href && /katex(?:\.min|-embedded)?\.css(?:$|[?#])/i.test(sheet.href))
  ));
  if (!stylesheet) {
    return '';
  }

  try {
    return Array.from(stylesheet.cssRules)
      .map((rule) => rule.cssText)
      .join('\n')
      .replace(/url\(\s*(["']?)([^"'()]+)\1\s*\)/g, (_match, _quote, rawUrl: string) => {
        const url = rawUrl.trim();
        if (/^(?:data:|blob:|https?:|vscode-webview:|#)/i.test(url)) {
          return `url("${url}")`;
        }
        try {
          return `url("${new URL(url, katexHref).toString()}")`;
        } catch {
          return `url("${url}")`;
        }
      });
  } catch {
    return '';
  }
}

export function createPreviewController({ vscode, onRendered, onFindRequested }: PreviewControllerOptions) {
  const host = document.createElement('div');
  host.className = 'preview-host';
  host.hidden = true;

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = 'Markdown Preview';
  frame.setAttribute('sandbox', 'allow-same-origin');

  const appearanceSegmentedControl = createSegmentedControl<PreviewAppearance>({
    ariaLabel: 'Preview appearance',
    className: 'preview-appearance-control',
    buttonClassName: 'preview-appearance-button',
    datasetKey: 'appearance',
    role: 'group',
    options: [
      {
        value: 'light',
        label: 'Light',
        renderLeading: () => createElement(Sun, { width: 14, height: 14, 'aria-hidden': 'true' })
      },
      {
        value: 'dark',
        label: 'Dark',
        renderLeading: () => createElement(Moon, { width: 14, height: 14, 'aria-hidden': 'true' })
      }
    ]
  });
  const appearanceControl = appearanceSegmentedControl.element;
  const lightAppearanceButton = appearanceSegmentedControl.getButton('light');
  const darkAppearanceButton = appearanceSegmentedControl.getButton('dark');

  const status = document.createElement('div');
  status.className = 'preview-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const scrollToTopController = createDocumentScrollToTopController();
  host.append(frame, status, scrollToTopController.button);

  let appearance: PreviewAppearance = 'dark';
  let requestCounter = 0;
  let pendingRequestId = '';
  let pendingRestoreLine: number | null = null;
  let pendingText = '';
  let latestRenderedText = '';
  let latestPayload: PreviewRenderedMessage | null = null;
  const previewMermaidRenderer = createPreviewMermaidRenderer();
  let searchQuery = '';
  let searchOptions = { wholeWord: false, caseSensitive: false };
  let searchMatches: HTMLElement[] = [];
  let activeSearchIndex = -1;

  const clearSearchMatches = (): void => {
    const frameDocument = frame.contentDocument;
    for (const match of Array.from(frameDocument?.querySelectorAll<HTMLElement>('.meo-preview-search-match') ?? [])) {
      const parent = match.parentNode;
      match.replaceWith(frameDocument!.createTextNode(match.textContent ?? ''));
      parent?.normalize();
    }
    searchMatches = [];
    activeSearchIndex = -1;
  };

  const refreshSearchMatches = (): void => {
    clearSearchMatches();
    const frameDocument = frame.contentDocument;
    const root = frameDocument?.querySelector<HTMLElement>('.meo-export-doc');
    if (!frameDocument || !root || !searchQuery) {
      return;
    }
    const query = searchOptions.caseSensitive ? searchQuery : searchQuery.toLocaleLowerCase();
    const textNodes: Text[] = [];
    const walker = frameDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        return parent && !parent.closest('script, style, noscript, svg')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text);
    }
    for (const textNode of textNodes) {
      const rawText = textNode.data;
      const comparableText = searchOptions.caseSensitive ? rawText : rawText.toLocaleLowerCase();
      const ranges: Array<{ start: number; end: number }> = [];
      let offset = 0;
      while (offset <= comparableText.length - query.length) {
        const start = comparableText.indexOf(query, offset);
        if (start < 0) {
          break;
        }
        const end = start + query.length;
        const isWordChar = (value: string) => /[\p{L}\p{N}_]/u.test(value);
        const wholeWordMatch = !searchOptions.wholeWord || (
          !isWordChar(rawText[start - 1] ?? '') && !isWordChar(rawText[end] ?? '')
        );
        if (wholeWordMatch) {
          ranges.push({ start, end });
        }
        offset = Math.max(end, start + 1);
      }
      if (ranges.length === 0) {
        continue;
      }
      const fragment = frameDocument.createDocumentFragment();
      let cursor = 0;
      for (const range of ranges) {
        fragment.append(frameDocument.createTextNode(rawText.slice(cursor, range.start)));
        const mark = frameDocument.createElement('mark');
        mark.className = 'meo-preview-search-match';
        mark.textContent = rawText.slice(range.start, range.end);
        fragment.append(mark);
        searchMatches.push(mark);
        cursor = range.end;
      }
      fragment.append(frameDocument.createTextNode(rawText.slice(cursor)));
      textNode.replaceWith(fragment);
    }
  };

  const setSearchQuery = (
    query: string,
    options: { wholeWord?: boolean; caseSensitive?: boolean } = {}
  ): void => {
    const nextOptions = {
      wholeWord: options.wholeWord === true,
      caseSensitive: options.caseSensitive === true
    };
    if (
      query === searchQuery &&
      nextOptions.wholeWord === searchOptions.wholeWord &&
      nextOptions.caseSensitive === searchOptions.caseSensitive
    ) {
      return;
    }
    searchQuery = query;
    searchOptions = nextOptions;
    refreshSearchMatches();
  };

  const findSearchMatch = (query: string, options: Record<string, unknown>, direction: 1 | -1) => {
    setSearchQuery(query, options);
    if (searchMatches.length === 0) {
      return { found: false, current: 0, total: 0 };
    }
    activeSearchIndex = (activeSearchIndex + direction + searchMatches.length) % searchMatches.length;
    for (const [index, match] of searchMatches.entries()) {
      match.classList.toggle('is-active', index === activeSearchIndex);
    }
    searchMatches[activeSearchIndex].scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, current: activeSearchIndex + 1, total: searchMatches.length };
  };

  const updateThemeToggle = () => appearanceSegmentedControl.setActive(appearance);

  const setStatus = (message: string | null) => {
    status.hidden = !message;
    status.textContent = message ?? '';
  };

  const renderFrame = (restoreLine: number | null = null) => {
    if (!latestPayload) {
      return;
    }
    const katexHref = document.body.dataset.meoKatexSrc ?? '';
    const katexInlineStyles = collectPreviewKatexStyles(katexHref).replace(/<\/style/gi, '<\\/style');
    const katexStylesTag = katexInlineStyles
      ? `<style data-meo-preview-katex>${katexInlineStyles}</style>`
      : katexHref
        ? `<link rel="stylesheet" href="${escapeHtmlAttribute(katexHref)}">`
        : '';
    const styles = latestPayload.styles[appearance].replace(/<\/style/gi, '<\\/style');
    frame.onload = () => {
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }
      scrollToTopController.setScrollElement(frameDocument.scrollingElement, frameDocument);
      frameDocument.body.tabIndex = -1;
      if (restoreLine !== null) {
        restoreTopLine(restoreLine);
      }
      bindPreviewLinks(frameDocument, vscode);
      bindPreviewWheelFallback(frameDocument);
      bindPreviewFindShortcut(frameDocument, onFindRequested);
      refreshSearchMatches();
      const keepPosition = () => {
        if (restoreLine !== null) {
          restoreTopLine(restoreLine);
        }
      };
      const finishRender = () => {
        keepPosition();
        scrollToTopController.sync();
        onRendered?.();
      };
      finishRender();
      if (latestPayload?.hasMermaid) {
        void previewMermaidRenderer.render(frameDocument, appearance, keepPosition).finally(keepPosition);
      }
    };
    scrollToTopController.setScrollElement(null);
    frame.srcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexStylesTag}<style data-meo-preview-styles>${styles}</style><style>${previewScrollbarStyles}.meo-export-doc a[data-meo-preview-href]{cursor:pointer}.meo-preview-search-match{background:#e0a800;color:inherit}.meo-preview-search-match.is-active{background:#ff8c00;outline:1px solid currentColor}</style></head><body><div class="meo-export-page"><main class="meo-export-doc">${latestPayload.html}</main></div></body></html>`;
  };

  const applyAppearanceToFrame = () => {
    const frameDocument = frame.contentDocument;
    const styleElement = frameDocument?.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
    if (!latestPayload || !frameDocument || !styleElement) {
      return;
    }
    const scrollTop = Number(frameDocument.scrollingElement?.scrollTop ?? 0);
    styleElement.textContent = latestPayload.styles[appearance];
    const keepPosition = () => {
      if (frameDocument.scrollingElement) {
        frameDocument.scrollingElement.scrollTop = scrollTop;
      }
    };
    const finish = () => {
      keepPosition();
      onRendered?.();
    };
    finish();
    if (latestPayload.hasMermaid) {
      void previewMermaidRenderer.render(frameDocument, appearance, keepPosition).finally(keepPosition);
    }
  };

  const setAppearance = (
    nextAppearance: PreviewAppearance,
    { post = false }: { post?: boolean } = {}
  ): void => {
    if (nextAppearance !== 'light' && nextAppearance !== 'dark') {
      return;
    }
    const changed = appearance !== nextAppearance;
    appearance = nextAppearance;
    updateThemeToggle();
    if (changed) {
      applyAppearanceToFrame();
    }
    if (post) {
      vscode.postMessage({ type: 'setPreviewAppearance', appearance });
    }
  };

  const requestRender = (
    text: string,
    { restoreLine = null, background = false }: { restoreLine?: number | null; background?: boolean } = {}
  ) => {
    if (latestPayload && text === latestRenderedText && frame.contentDocument?.querySelector('.meo-export-doc')) {
      setStatus(null);
      if (restoreLine !== null) {
        restoreTopLine(restoreLine);
      }
      onRendered?.();
      return;
    }
    if (pendingRequestId && text === pendingText) {
      if (restoreLine !== null) pendingRestoreLine = restoreLine;
      if (!background) setStatus('正在生成预览…');
      return;
    }
    const requestId = `preview-${Date.now()}-${requestCounter += 1}`;
    pendingRequestId = requestId;
    pendingRestoreLine = restoreLine;
    pendingText = text;
    if (!background) setStatus('正在生成预览…');
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
    latestRenderedText = pendingText;
    pendingRequestId = '';
    setStatus(null);
    const restoreLine = pendingRestoreLine;
    pendingRestoreLine = null;
    renderFrame(restoreLine);
  };

  const handleRenderError = (message: PreviewRenderErrorMessage) => {
    if (message.requestId === pendingRequestId) {
      pendingRequestId = '';
      setStatus(message.message || 'Preview 生成失败');
    }
  };

  appearanceControl.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.preview-appearance-button[data-appearance]')
      : null;
    const nextAppearance = button?.dataset.appearance;
    if (nextAppearance !== 'light' && nextAppearance !== 'dark') {
      return;
    }
    setAppearance(nextAppearance, { post: true });
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
        const candidateRange = candidate ? getSourceRange(candidate) : null;
        const fallback = candidateRange && line - candidateRange.end <= range.start - line
          ? candidate
          : element;
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
    appearanceControl,
    requestRender,
    preload: (text: string) => requestRender(text, { background: true }),
    handleRendered,
    handleRenderError,
    setAppearance,
    getAppearance: () => appearance,
    setVisible: (visible: boolean) => {
      host.hidden = !visible;
    },
    focus: () => {
      frame.focus();
      frame.contentWindow?.focus();
      frame.contentDocument?.body.focus({ preventScroll: true });
    },
    getTopVisiblePosition,
    restoreTopLine,
    getSelectedText: () => frame.contentWindow?.getSelection()?.toString() ?? '',
    getSearchAdapter: () => ({
      setSearchQuery,
      countMatches: () => searchMatches.length,
      findNext: (query: string, options: Record<string, unknown>) => findSearchMatch(query, options, 1),
      findPrevious: (query: string, options: Record<string, unknown>) => findSearchMatch(query, options, -1),
      focus: () => {
        frame.focus();
        frame.contentWindow?.focus();
      }
    }),
    getOutlineAdapter: () => outlineAdapter
  };
}

function bindPreviewFindShortcut(frameDocument: Document, onFindRequested?: () => void): void {
  frameDocument.addEventListener('keydown', (event) => {
    const hasPrimaryModifier = event.metaKey !== event.ctrlKey && (event.metaKey || event.ctrlKey);
    if (
      !hasPrimaryModifier ||
      event.altKey ||
      event.shiftKey ||
      (event.key.toLowerCase() !== 'f' && event.code !== 'KeyF')
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onFindRequested?.();
  }, { capture: true });
}

function bindPreviewLinks(
  frameDocument: Document,
  vscode: { postMessage: (message: WebviewMessage) => void }
): void {
  for (const link of frameDocument.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href')?.trim() ?? '';
    if (!href) {
      continue;
    }
    link.dataset.meoPreviewHref = href;
    link.removeAttribute('href');
    link.setAttribute('role', 'link');
    if (!link.hasAttribute('tabindex')) {
      link.tabIndex = 0;
    }
  }

  const activateLink = (event: Event) => {
    const target = typeof (event.target as Element | null)?.closest === 'function'
      ? (event.target as Element).closest<HTMLAnchorElement>('a[data-meo-preview-href]')
      : null;
    if (!target) {
      return;
    }
    const href = target.dataset.meoPreviewHref?.trim() ?? '';
    if (!href) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (href.startsWith('#')) {
      let fragmentId = href.slice(1);
      try {
        fragmentId = decodeURIComponent(fragmentId);
      } catch {
        // Keep the literal fragment when it contains malformed escaping.
      }
      frameDocument.getElementById(fragmentId)?.scrollIntoView({ block: 'start' });
      return;
    }
    vscode.postMessage({ type: 'openLink', href, source: 'preview' });
  };

  frameDocument.addEventListener('click', activateLink, { capture: true });
  frameDocument.addEventListener('auxclick', activateLink, { capture: true });
  frameDocument.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      activateLink(event);
    }
  }, { capture: true });
}

function bindPreviewWheelFallback(frameDocument: Document): void {
  frameDocument.addEventListener('wheel', (event) => {
    if (event.ctrlKey) {
      return;
    }
    const scrollElement = frameDocument.scrollingElement;
    if (!scrollElement) {
      return;
    }
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? frameDocument.defaultView?.innerHeight ?? 1
        : 1;
    event.preventDefault();
    scrollElement.scrollTop += event.deltaY * deltaScale;
  }, { passive: false });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
