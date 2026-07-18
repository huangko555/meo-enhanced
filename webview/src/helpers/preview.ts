import { createElement, Moon, Sun } from 'lucide';
import { getExportStyleEnvironment } from './export';
import {
  loadMermaidRuntime,
  restoreMermaidEditorTheme,
  runExclusiveMermaidOperation
} from './mermaidDiagram';
import type { OutlineHeading } from './outline';
import type { PreviewAppearance, PreviewRenderErrorMessage, PreviewRenderedMessage } from '../../../src/shared/preview';

type PreviewControllerOptions = {
  vscode: { postMessage: (message: WebviewMessage) => void };
  onRendered?: () => void;
  onFindRequested?: () => void;
};

export function createPreviewController({ vscode, onRendered, onFindRequested }: PreviewControllerOptions) {
  const host = document.createElement('div');
  host.className = 'preview-host';
  host.hidden = true;

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = 'Markdown Preview';
  frame.setAttribute('sandbox', 'allow-same-origin');

  const appearanceControl = document.createElement('div');
  appearanceControl.className = 'preview-appearance-control';
  appearanceControl.setAttribute('role', 'group');
  appearanceControl.setAttribute('aria-label', 'Preview appearance');

  const createAppearanceButton = (value: PreviewAppearance, label: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preview-appearance-button';
    button.dataset.appearance = value;
    button.append(
      createElement(value === 'light' ? Sun : Moon, { width: 14, height: 14, 'aria-hidden': 'true' }),
      document.createTextNode(label)
    );
    return button;
  };
  const lightAppearanceButton = createAppearanceButton('light', 'Light');
  const darkAppearanceButton = createAppearanceButton('dark', 'Dark');
  appearanceControl.append(lightAppearanceButton, darkAppearanceButton);

  const status = document.createElement('div');
  status.className = 'preview-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  host.append(frame, status);

  let appearance: PreviewAppearance = 'dark';
  let requestCounter = 0;
  let pendingRequestId = '';
  let pendingRestoreLine: number | null = null;
  let pendingText = '';
  let latestRenderedText = '';
  let latestPayload: PreviewRenderedMessage | null = null;
  let mermaidRenderQueue: Promise<void> = Promise.resolve();
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

  const renderPreviewMermaid = (frameDocument: Document, renderAppearance: PreviewAppearance): Promise<void> => {
    mermaidRenderQueue = mermaidRenderQueue
      .catch(() => undefined)
      .then(() => runExclusiveMermaidOperation(async () => {
        try {
          await renderMermaidBlocks(frameDocument, renderAppearance);
        } finally {
          await restoreMermaidEditorTheme();
        }
      }));
    return mermaidRenderQueue;
  };

  const updateThemeToggle = () => {
    for (const button of [lightAppearanceButton, darkAppearanceButton]) {
      const active = button.dataset.appearance === appearance;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  };

  const setStatus = (message: string | null) => {
    status.hidden = !message;
    status.textContent = message ?? '';
  };

  const renderFrame = (restoreLine: number | null = null) => {
    if (!latestPayload) {
      return;
    }
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
      frameDocument.body.tabIndex = -1;
      if (restoreLine !== null) {
        restoreTopLine(restoreLine);
      }
      bindPreviewLinks(frameDocument, vscode);
      bindPreviewWheelFallback(frameDocument);
      bindPreviewFindShortcut(frameDocument, onFindRequested);
      refreshSearchMatches();
      const finishRender = () => {
        // Mermaid replaces placeholders asynchronously, so restore again after its layout settles.
        if (restoreLine !== null) {
          restoreTopLine(restoreLine);
        }
        onRendered?.();
      };
      if (latestPayload?.hasMermaid) {
        void renderPreviewMermaid(frameDocument, appearance).finally(finishRender);
      } else {
        finishRender();
      }
    };
    frame.srcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexLink}<style data-meo-preview-styles>${styles}</style><style>.meo-preview-search-match{background:#e0a800;color:inherit}.meo-preview-search-match.is-active{background:#ff8c00;outline:1px solid currentColor}</style></head><body><div class="meo-export-page"><main class="meo-export-doc">${latestPayload.html}</main></div></body></html>`;
  };

  const applyAppearanceToFrame = () => {
    const frameDocument = frame.contentDocument;
    const styleElement = frameDocument?.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
    if (!latestPayload || !frameDocument || !styleElement) {
      return;
    }
    const scrollTop = Number(frameDocument.scrollingElement?.scrollTop ?? 0);
    styleElement.textContent = latestPayload.styles[appearance];
    const finish = () => {
      if (frameDocument.scrollingElement) {
        frameDocument.scrollingElement.scrollTop = scrollTop;
      }
      onRendered?.();
    };
    if (latestPayload.hasMermaid) {
      void renderPreviewMermaid(frameDocument, appearance).finally(finish);
    } else {
      finish();
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

  const requestRender = (text: string, { restoreLine = null }: { restoreLine?: number | null } = {}) => {
    if (latestPayload && text === latestRenderedText && frame.contentDocument?.querySelector('.meo-export-doc')) {
      setStatus(null);
      if (restoreLine !== null) {
        restoreTopLine(restoreLine);
      }
      onRendered?.();
      return;
    }
    const requestId = `preview-${Date.now()}-${requestCounter += 1}`;
    pendingRequestId = requestId;
    pendingRestoreLine = restoreLine;
    pendingText = text;
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
    latestRenderedText = pendingText;
    setStatus(null);
    const restoreLine = pendingRestoreLine;
    pendingRestoreLine = null;
    renderFrame(restoreLine);
  };

  const handleRenderError = (message: PreviewRenderErrorMessage) => {
    if (message.requestId === pendingRequestId) {
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
  frameDocument.addEventListener('click', (event) => {
    const FrameElement = frameDocument.defaultView?.Element;
    const target = FrameElement && event.target instanceof FrameElement
      ? event.target.closest<HTMLAnchorElement>('a[href]')
      : null;
    if (!target) {
      return;
    }
    const href = target.getAttribute('href')?.trim() ?? '';
    if (!href) {
      return;
    }
    if (href.startsWith('#')) {
      event.preventDefault();
      let fragmentId = href.slice(1);
      try {
        fragmentId = decodeURIComponent(fragmentId);
      } catch {
        // Keep the literal fragment when it contains malformed escaping.
      }
      frameDocument.getElementById(fragmentId)?.scrollIntoView({ block: 'start' });
      return;
    }
    event.preventDefault();
    vscode.postMessage({ type: 'openLink', href });
  });
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
    const before = scrollElement.scrollTop;
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? frameDocument.defaultView?.innerHeight ?? 1
        : 1;
    frameDocument.defaultView?.requestAnimationFrame(() => {
      if (scrollElement.scrollTop === before) {
        scrollElement.scrollTop += event.deltaY * deltaScale;
      }
    });
  }, { passive: true });
}

async function renderMermaidBlocks(frameDocument: Document, appearance: PreviewAppearance): Promise<void> {
  const blocks = Array.from(frameDocument.querySelectorAll<HTMLElement>('.meo-export-mermaid[data-source-b64]'));
  if (blocks.length === 0) {
    return;
  }
  const mermaid = await loadMermaidRuntime();
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
