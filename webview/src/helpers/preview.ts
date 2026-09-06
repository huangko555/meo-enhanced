import { getExportStyleEnvironment } from './export';
import { createPreviewMermaidRenderer } from './previewMermaid';
import { logWebviewRenderError } from './errors';
import { createDocumentScrollToTopController } from './scrollToTop';
import type { OutlineHeading } from './outline';
import type { EditorAppearance as PreviewAppearance } from '../../../src/protocol/editorCommands';
import type { PreviewRenderResponse, PreviewRenderValue } from '../../../src/protocol/previewRender';
import { createPreviewRenderTransport } from '../adapters/previewRenderTransport';
import { attachLatexMathViewport, type LatexMathViewportController } from './latexMathViewport';
import type { MermaidDiagramRenderResources } from '../application/mermaidDiagramRenderResources';
import type { PreviewCodePalette } from '../application/finalCodePalette';
import { normalizePreviewFontFamily } from '../../../src/shared/preview';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { applyPreviewCodeHighlight } from './previewCodeHighlight';
import { activateShikiCodeHighlighting, subscribeShikiRefresh } from './shikiHighlighter';
import { createToolbarDropdown } from './toolbarDropdown';
import { resolveEmbeddedImageSrc } from './images';

type PreviewControllerOptions = {
  vscode: { postMessage: (message: WebviewMessage) => void };
  uiLanguage: UiLanguage;
  getEditorAppearance: () => 'light' | 'dark';
  getCodePalette: (appearance: 'light' | 'dark') => PreviewCodePalette;
  applyCodeTheme: (appearance: 'light' | 'dark') => void;
  onRendered?: () => void;
  onPaintReady?: () => void;
  onFindRequested?: () => void;
  onViewportInteraction?: () => void;
  runViewportTransaction?: (mutate: () => void) => void;
  mermaidRenderResources: MermaidDiagramRenderResources;
};

type PreviewViewportRestore = {
  readonly line: number;
  readonly lineOffset: number;
  readonly isCurrent: () => boolean;
};

type PreviewViewportProjectionSlot = {
  restore: PreviewViewportRestore | null;
};

const previewScrollbarStyles = `
html[data-meo-preview-source-coloring="false"] .meo-export-code-line-source > span {
  color: inherit !important;
  font-style: inherit !important;
  font-weight: inherit !important;
  text-decoration: inherit !important;
}

html,
body {
  overflow-anchor: none;
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

const previewFontFamilies = [
  'Microsoft YaHei',
  'Segoe UI',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'SimSun',
  'Arial',
  'Georgia'
] as const;

const previewLatexMathViewportStyles = `
.meo-export-math-display.meo-export-math-fenced-display {
  padding-block: 1em;
}

.meo-export-math-display.meo-latex-math-viewport {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-width: 0;
  overflow: visible !important;
}

.meo-export-math-display > .meo-latex-math-canvas {
  position: relative;
  flex: 0 0 auto;
  width: max-content;
  max-width: none;
}

.meo-export-math-display > .meo-latex-math-canvas > .katex-display {
  width: max-content;
  margin: 0;
}

.meo-export-math-inline.meo-latex-math-viewport {
  align-items: baseline;
  overflow: visible !important;
}

.meo-export-math-inline > .meo-latex-math-canvas {
  display: inline-block;
  flex: 0 0 auto;
  width: max-content;
  max-width: none;
  vertical-align: baseline;
  white-space: nowrap;
}
`;

const previewPropertiesStyles = `
.meo-export-frontmatter {
  --meo-preview-properties-key-width: 124px;
  padding-inline: 0;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
}

.meo-export-frontmatter-header {
  margin-bottom: 0;
  padding: 5px 12px;
  font-size: inherit;
  line-height: inherit;
  /* Match one property line plus its vertical padding and separator. Keep
     the smaller title font independent of the row's height. */
  min-height: max(1.7em, calc(1lh + 11px));
}

.meo-export-frontmatter-header > span:last-child {
  font-size: 0.82em;
  line-height: 1.2;
}

.meo-export-frontmatter-line {
  padding: 5px 12px;
  border-radius: 0;
  border-top: 1px solid color-mix(in srgb, var(--meo-border) 62%, transparent);
}

.meo-export-frontmatter-line.is-property {
  grid-template-columns: var(--meo-preview-properties-key-width) minmax(0, 1fr);
  column-gap: 0;
  padding: 0 12px 0 0;
}

.meo-export-frontmatter-key-cell {
  box-sizing: border-box;
  min-height: 100%;
  padding: 5px 10px 5px 12px;
  border-right: 1px solid color-mix(in srgb, var(--meo-border) 82%, transparent);
  background: color-mix(in srgb, var(--meo-border) 13%, transparent);
}

.meo-export-frontmatter-line.is-property > :is(
  .meo-export-frontmatter-value,
  .meo-export-frontmatter-value-group
) {
  padding: 5px 0 5px 16px;
}

.meo-export-frontmatter-value-line + .meo-export-frontmatter-value-line {
  margin-top: 2px;
}

.meo-export-frontmatter-line:is(.is-list-item, .is-raw) {
  padding-left: calc(var(--meo-preview-properties-key-width) + 16px);
}

@media (max-width: 520px) {
  .meo-export-frontmatter {
    --meo-preview-properties-key-width: 92px;
  }
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

export function createPreviewController({
  vscode,
  uiLanguage: initialUiLanguage,
  getEditorAppearance,
  getCodePalette,
  applyCodeTheme,
  onRendered,
  onPaintReady,
  onFindRequested,
  onViewportInteraction,
  runViewportTransaction,
  mermaidRenderResources
}: PreviewControllerOptions) {
  let uiLanguage = initialUiLanguage;
  let uiStrings = getUiStrings(uiLanguage);
  const host = document.createElement('div');
  host.className = 'preview-host';
  host.hidden = true;
  host.inert = true;

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = uiStrings.previewTitle;
  frame.setAttribute('sandbox', 'allow-same-origin');

  const appearanceSelectControl = createToolbarDropdown('preview-appearance-control', uiStrings.previewAppearance);
  const appearanceControl = appearanceSelectControl.element;
  const appearanceSelect = appearanceSelectControl.select;
  appearanceSelect.classList.add('preview-appearance-select');
  for (const value of ['auto', 'light', 'dark'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'auto' ? uiStrings.auto : value === 'light' ? uiStrings.light : uiStrings.dark;
    appearanceSelect.append(option);
  }
  appearanceSelectControl.refreshOptions();

  const sourceColoringSelectControl = createToolbarDropdown('preview-source-coloring-control', uiStrings.previewCodeColors);
  const sourceColoringControl = sourceColoringSelectControl.element;
  sourceColoringControl.classList.add('preview-source-coloring');
  const sourceColoringSelect = sourceColoringSelectControl.select;
  sourceColoringSelect.classList.add('preview-source-coloring-select');
  for (const enabled of [true, false]) {
    const option = document.createElement('option');
    option.value = String(enabled);
    option.textContent = enabled ? uiStrings.previewCodeColorsOn : uiStrings.previewCodeColorsOff;
    sourceColoringSelect.append(option);
  }
  sourceColoringSelectControl.refreshOptions();
  const fontFamilySelectControl = createToolbarDropdown('preview-font-family-control', uiStrings.previewFontFamily);
  const fontFamilyControl = fontFamilySelectControl.element;
  const fontFamilyLabel = fontFamilySelectControl.label;
  const fontFamilySelect = fontFamilySelectControl.select;
  fontFamilySelect.classList.add('preview-font-family-select');
  const defaultFontOption = document.createElement('option');
  defaultFontOption.value = '';
  defaultFontOption.textContent = uiStrings.previewFontPlaceholder;
  fontFamilySelect.append(defaultFontOption);
  for (const family of previewFontFamilies) {
    const option = document.createElement('option');
    option.value = family;
    option.textContent = family;
    fontFamilySelect.append(option);
  }
  fontFamilySelectControl.refreshOptions();

  const status = document.createElement('div');
  status.className = 'preview-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const applyUiLanguage = (language: UiLanguage): void => {
    uiLanguage = language;
    uiStrings = getUiStrings(language);
    frame.title = uiStrings.previewTitle;
    appearanceSelectControl.setLabel(uiStrings.previewAppearance);
    appearanceSelect.options[0].textContent = uiStrings.auto;
    appearanceSelect.options[1].textContent = uiStrings.light;
    appearanceSelect.options[2].textContent = uiStrings.dark;
    appearanceSelectControl.refreshOptions();
    sourceColoringSelectControl.setLabel(uiStrings.previewCodeColors);
    sourceColoringSelect.options[0].textContent = uiStrings.previewCodeColorsOn;
    sourceColoringSelect.options[1].textContent = uiStrings.previewCodeColorsOff;
    sourceColoringSelectControl.refreshOptions();
    fontFamilySelectControl.setLabel(uiStrings.previewFontFamily);
    defaultFontOption.textContent = uiStrings.previewFontPlaceholder;
    fontFamilySelectControl.refreshOptions();
    scrollToTopController.setUiLanguage(language);
  };

  const scrollToTopController = createDocumentScrollToTopController(uiLanguage);
  host.append(frame, status, scrollToTopController.button);

  let appearancePreference: PreviewAppearance = 'auto';
  let appearance: 'light' | 'dark' = 'dark';
  let sourceColoring = true;
  let fontFamilyPreference = '';
  let requestGeneration = 0;
  let frameGeneration = 0;
  let mermaidPresentationGeneration = 0;
  let activeFrameDocument: Document | null = null;
  let pendingPresentationScroll: { document: Document; scrollTop: number } | null = null;
  let viewportInteractionGeneration = 0;
  let hasPendingRequest = false;
  let pendingViewportRestore: PreviewViewportRestore | null = null;
  let acceptingViewportProjection: PreviewViewportProjectionSlot | null = null;
  let pendingText = '';
  let latestAcceptedText: string | null = null;
  let frameRenderedText: string | null = null;
  let latestPayload: PreviewRenderValue | null = null;
  const previewRenderTransport = createPreviewRenderTransport((message) => vscode.postMessage(message));
  const previewMermaidRenderer = createPreviewMermaidRenderer(
    mermaidRenderResources,
    (error) => logWebviewRenderError('preview.mermaid', error)
  );
  let searchQuery = '';
  let searchOptions = { wholeWord: false, caseSensitive: false };
  let searchMatches: HTMLElement[] = [];
  let activeSearchIndex = -1;
  let previewMathViewports: LatexMathViewportController[] = [];
  let disposeDeferredImages = () => {};
  let disposed = false;
  let paintFrame: number | null = null;
  let highlightFrame: number | null = null;
  const cancelHighlightFrame = () => {
    if (highlightFrame !== null) window.cancelAnimationFrame(highlightFrame);
    highlightFrame = null;
  };
  const scheduleViewportHighlight = (frameDocument: Document) => {
    if (highlightFrame !== null) return;
    highlightFrame = window.requestAnimationFrame(() => {
      highlightFrame = null;
      if (!disposed && sourceColoring && activeFrameDocument === frameDocument) {
        applyPreviewCodeHighlight(frameDocument, true);
      }
    });
  };
  const cancelPaintReady = () => {
    if (paintFrame !== null) window.cancelAnimationFrame(paintFrame);
    paintFrame = null;
  };
  const schedulePaintReady = () => {
    cancelPaintReady();
    if (disposed || host.hidden) return;
    // A visible iframe can still have no compositor surface in this frame.
    // Keep the previous reading surface until the browser has painted it.
    paintFrame = window.requestAnimationFrame(() => {
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = null;
        if (!disposed && !host.hidden) onPaintReady?.();
      });
    });
  };
  const releasePreviewCodeHighlighting = activateShikiCodeHighlighting('preview');
  const unsubscribePreviewCodeHighlight = subscribeShikiRefresh(() => {
    if (!disposed && sourceColoring && activeFrameDocument) {
      applyPreviewCodeHighlight(activeFrameDocument, true);
    }
  }, 'preview');

  const withViewportTransaction = (
    mutate: (slot: PreviewViewportProjectionSlot) => void
  ): void => {
    const slot: PreviewViewportProjectionSlot = { restore: null };
    const previousSlot = acceptingViewportProjection;
    acceptingViewportProjection = slot;
    try {
      if (runViewportTransaction) runViewportTransaction(() => mutate(slot));
      else mutate(slot);
    } finally {
      acceptingViewportProjection = previousSlot;
    }
  };

  const disposePreviewMathViewports = () => {
    for (const viewport of previewMathViewports) {
      viewport.destroy();
    }
    previewMathViewports = [];
  };

  const attachDeferredImages = (frameDocument: Document) => {
    disposeDeferredImages();
    const abortController = new AbortController();
    const images = Array.from(frameDocument.querySelectorAll<HTMLImageElement>(
      'img[data-meo-deferred-image-src]'
    ));
    const loadImage = async (image: HTMLImageElement) => {
      const rawSrc = image.getAttribute('data-meo-deferred-image-src') ?? '';
      image.removeAttribute('data-meo-deferred-image-src');
      const resolvedSrc = await resolveEmbeddedImageSrc(rawSrc, abortController.signal);
      if (
        abortController.signal.aborted ||
        disposed ||
        activeFrameDocument !== frameDocument
      ) return;
      if (!resolvedSrc) {
        if (host.hidden) image.removeAttribute('src');
        else withViewportTransaction(() => image.removeAttribute('src'));
        return;
      }
      // Load outside the reading layout so intrinsic dimensions do not change
      // before the shared viewport owner can capture the current reading anchor.
      const prepared = image.cloneNode(false) as HTMLImageElement;
      prepared.removeAttribute('src');
      prepared.loading = 'eager';
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          prepared.onload = null;
          prepared.onerror = null;
          abortController.signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          finish();
          prepared.removeAttribute('src');
        };
        prepared.onload = () => { void prepared.decode().catch(() => undefined).then(finish); };
        prepared.onerror = finish;
        abortController.signal.addEventListener('abort', abort, { once: true });
        prepared.src = resolvedSrc;
      });
      if (abortController.signal.aborted || disposed || activeFrameDocument !== frameDocument) return;
      // Keep attributes that may have changed while loading, including authored
      // dimensions. Link handlers live on ancestors and survive this replacement.
      for (const attribute of Array.from(prepared.attributes)) {
        if (attribute.name !== 'src') prepared.removeAttribute(attribute.name);
      }
      for (const attribute of Array.from(image.attributes)) {
        if (attribute.name !== 'src') prepared.setAttribute(attribute.name, attribute.value);
      }
      const commit = () => image.replaceWith(prepared);
      if (host.hidden) commit();
      else withViewportTransaction(commit);
    };
    const FrameIntersectionObserver = frame.contentWindow
      ? (frame.contentWindow as unknown as Pick<typeof globalThis, 'IntersectionObserver'>).IntersectionObserver
      : null;
    const observer = FrameIntersectionObserver
      ? new FrameIntersectionObserver((entries: IntersectionObserverEntry[]) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer?.unobserve(entry.target);
            void loadImage(entry.target as HTMLImageElement);
          }
        }, { rootMargin: '800px 0px' })
      : null;
    if (observer) {
      for (const image of images) observer.observe(image);
    } else {
      for (const image of images) void loadImage(image);
    }
    disposeDeferredImages = () => {
      observer?.disconnect();
      abortController.abort();
      disposeDeferredImages = () => {};
    };
  };

  const attachPreviewMathViewports = (frameDocument: Document) => {
    disposePreviewMathViewports();
    previewMathViewports = Array.from(frameDocument.querySelectorAll<HTMLElement>(
      '.meo-export-math-display, .meo-export-math-inline'
    )).map((element) => (
      element.classList.contains('meo-export-math-inline')
        ? attachLatexMathViewport(element, { layout: { kind: 'inline' } })
        : attachLatexMathViewport(element)
    ));
  };

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

  const updateThemeToggle = () => {
    appearanceSelect.value = appearancePreference;
    const toolbarAppearance = getEditorAppearance();
    for (const control of [appearanceSelectControl, sourceColoringSelectControl, fontFamilySelectControl]) {
      control.setAppearance(toolbarAppearance);
    }
    appearanceSelectControl.syncFromSelect();
  };

  const syncPreviewCodeHighlight = (frameDocument: Document): void => {
    frameDocument.documentElement.dataset.meoPreviewSourceColoring = String(sourceColoring);
    if (sourceColoring) applyPreviewCodeHighlight(frameDocument, true);
  };

  const capturePresentationScroll = (): void => {
    const frameDocument = activeFrameDocument;
    const scrollElement = frameDocument?.scrollingElement;
    if (!frameDocument || !scrollElement) return;
    if (!pendingPresentationScroll || pendingPresentationScroll.document !== frameDocument) {
      pendingPresentationScroll = {
        document: frameDocument,
        scrollTop: scrollElement.scrollTop
      };
    }
  };

  const setStatus = (message: string | null) => {
    status.hidden = !message;
    status.textContent = message ?? '';
  };

  const renderFrame = (
    renderedText: string,
    viewportRestore: PreviewViewportRestore | null = null
  ) => {
    if (disposed || !latestPayload) {
      return;
    }
    const payload = latestPayload;
    cancelHighlightFrame();
    const loadGeneration = frameGeneration + 1;
    frameGeneration = loadGeneration;
    mermaidPresentationGeneration += 1;
    activeFrameDocument = null;
    pendingPresentationScroll = null;
    frameRenderedText = null;
    disposeDeferredImages();
    frame.style.visibility = 'hidden';
    const katexHref = document.body.dataset.meoKatexSrc ?? '';
    const katexInlineStyles = collectPreviewKatexStyles(katexHref).replace(/<\/style/gi, '<\\/style');
    const katexStylesTag = katexInlineStyles
      ? `<style data-meo-preview-katex>${katexInlineStyles}</style>`
      : katexHref
        ? `<link rel="stylesheet" href="${escapeHtmlAttribute(katexHref)}">`
        : '';
    const styles = payload.styles[appearance].replace(/<\/style/gi, '<\\/style');
    frame.onload = () => {
      if (disposed || loadGeneration !== frameGeneration) return;
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }
      activeFrameDocument = frameDocument;
      frameRenderedText = renderedText;
      const styleElement = frameDocument.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
      if (styleElement) styleElement.textContent = payload.styles[appearance];
      const presentationGeneration = mermaidPresentationGeneration + 1;
      mermaidPresentationGeneration = presentationGeneration;
      const isCurrent = () => (
        !disposed &&
        loadGeneration === frameGeneration &&
        presentationGeneration === mermaidPresentationGeneration &&
        frame.contentDocument === frameDocument
      );
      scrollToTopController.setScrollElement(frameDocument.scrollingElement, frameDocument);
      frameDocument.body.tabIndex = -1;
      attachPreviewMathViewports(frameDocument);
      syncPreviewCodeHighlight(frameDocument);
      frameDocument.addEventListener('scroll', () => {
        if (!disposed && activeFrameDocument === frameDocument && sourceColoring) scheduleViewportHighlight(frameDocument);
      }, { passive: true });
      if (viewportRestore?.isCurrent()) {
        restoreTopLine(viewportRestore.line, viewportRestore.lineOffset);
      }
      const notifyViewportInteraction = (event: Event) => {
        if (!event.isTrusted) return;
        viewportInteractionGeneration += 1;
        pendingPresentationScroll = null;
        onViewportInteraction?.();
      };
      for (const type of ['wheel', 'pointerdown', 'keydown', 'beforeinput', 'selectionchange', 'focusin']) {
        frameDocument.addEventListener(type, notifyViewportInteraction, true);
      }
      // Pointer events do not bubble out of an iframe. Notify the outer document
      // at the frame boundary so existing outside-click handlers dismiss popups.
      // Keep the original event intact for selection and link activation inside.
      frameDocument.addEventListener('pointerdown', (event) => {
        frame.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          button: event.button,
          buttons: event.buttons
        }));
      }, true);
      bindPreviewLinks(frameDocument, vscode);
      bindPreviewWheelFallback(frameDocument);
      bindPreviewFindShortcut(frameDocument, onFindRequested);
      refreshSearchMatches();
      const keepPosition = () => {
        if (
          disposed ||
          !isCurrent()
        ) return;
        if (viewportRestore?.isCurrent()) {
          restoreTopLine(viewportRestore.line, viewportRestore.lineOffset);
        }
      };
      const finishRender = () => {
        keepPosition();
        frame.style.removeProperty('visibility');
        scrollToTopController.sync();
        onRendered?.();
        schedulePaintReady();
      };
      finishRender();
      attachDeferredImages(frameDocument);
      if (payload.hasMermaid) {
        void previewMermaidRenderer.render(frameDocument, appearance, keepPosition, isCurrent).finally(keepPosition);
      }
    };
    disposePreviewMathViewports();
    scrollToTopController.setScrollElement(null);
    frame.srcdoc = `<!DOCTYPE html><html lang="${uiLanguage}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexStylesTag}<style data-meo-preview-styles>${styles}</style><style>${previewScrollbarStyles}${previewLatexMathViewportStyles}${previewPropertiesStyles}.meo-export-doc a[data-meo-preview-href]{cursor:pointer}.meo-preview-search-match{background:#e0a800;color:inherit}.meo-preview-search-match.is-active{background:#ff8c00;outline:1px solid currentColor}</style></head><body><div class="meo-export-page"><main class="meo-export-doc">${payload.html}</main></div></body></html>`;
  };

  const applyAppearanceToFrame = () => {
    if (disposed) return;
    const frameDocument = activeFrameDocument;
    const styleElement = frameDocument?.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
    if (!latestPayload || !frameDocument || !styleElement) {
      return;
    }
    const payload = latestPayload;
    const scrollElement = frameDocument.scrollingElement;
    const preservedScrollTop = pendingPresentationScroll?.document === frameDocument
      ? pendingPresentationScroll.scrollTop
      : scrollElement?.scrollTop ?? 0;
    const interactionGeneration = viewportInteractionGeneration;
    const presentationGeneration = mermaidPresentationGeneration + 1;
    mermaidPresentationGeneration = presentationGeneration;
    const isCurrent = () => (
      !disposed &&
      presentationGeneration === mermaidPresentationGeneration &&
      activeFrameDocument === frameDocument &&
      frame.contentDocument === frameDocument
    );
    const keepPosition = () => {
      // Let the appearance render finish, but retire its old reading offset as
      // soon as the user interacts with the frame during asynchronous work.
      if (isCurrent() && interactionGeneration === viewportInteractionGeneration && scrollElement) {
        if (Math.abs(scrollElement.scrollTop - preservedScrollTop) > 0.1) {
          scrollElement.scrollTop = preservedScrollTop;
        }
      }
    };
    // This is a presentation-only update of the same frame and document. A
    // cross-surface semantic projection would race this exact reading offset.
    styleElement.textContent = payload.styles[appearance];
    syncPreviewCodeHighlight(frameDocument);
    keepPosition();
    onRendered?.();
    if (payload.hasMermaid) {
      void previewMermaidRenderer.render(frameDocument, appearance, keepPosition, isCurrent).finally(keepPosition);
    }
    if (!hasPendingRequest && pendingPresentationScroll?.document === frameDocument) {
      pendingPresentationScroll = null;
    }
  };

  const setAppearance = (
    nextAppearance: PreviewAppearance,
    { post = false }: { post?: boolean } = {}
  ): void => {
    if (nextAppearance !== 'auto' && nextAppearance !== 'light' && nextAppearance !== 'dark') {
      return;
    }
    const resolvedAppearance = nextAppearance === 'auto' ? getEditorAppearance() : nextAppearance;
    const changed = appearance !== resolvedAppearance;
    if (changed) capturePresentationScroll();
    appearancePreference = nextAppearance;
    appearance = resolvedAppearance;
    applyCodeTheme(resolvedAppearance);
    updateThemeToggle();
    if (changed && activeFrameDocument) {
      applyAppearanceToFrame();
    }
    if (post) {
      vscode.postMessage({ type: 'setPreviewAppearance', appearance: appearancePreference });
    }
  };

  const getStyleEnvironment = () => getExportStyleEnvironment({
    previewFontFamily: fontFamilyPreference,
    previewSourceColoring: sourceColoring,
    previewCodePalettes: {
      light: getCodePalette('light'),
      dark: getCodePalette('dark')
    }
  });

  const performRequestRender = (
    text: string,
    { background = false, force = false, preserveFrame = false }: {
      background?: boolean;
      force?: boolean;
      preserveFrame?: boolean;
    } = {}
  ) => {
    if (disposed) return;
    if (!force
      && latestPayload
      && text === latestAcceptedText
      && text === frameRenderedText
      && frame.contentDocument?.querySelector('.meo-export-doc')) {
      setStatus(null);
      onRendered?.();
      schedulePaintReady();
      return;
    }
    if (!force && hasPendingRequest && text === pendingText) {
      if (!background) setStatus(uiStrings.previewGenerating);
      return;
    }
    const generation = requestGeneration + 1;
    cancelPaintReady();
    const requestText = text;
    requestGeneration = generation;
    hasPendingRequest = true;
    pendingViewportRestore = null;
    pendingText = text;
    if (!background) setStatus(uiStrings.previewGenerating);
    void previewRenderTransport.render({
      text,
      uiLanguage,
      environment: getStyleEnvironment()
    }).then((result) => {
      if (generation !== requestGeneration) return;
      hasPendingRequest = false;
      if (result.ok === false) {
        pendingViewportRestore = null;
        setStatus(uiStrings.previewFailed);
        schedulePaintReady();
        return;
      }
      latestPayload = result.value;
      latestAcceptedText = requestText;
      setStatus(null);
      const viewportRestore = pendingViewportRestore;
      pendingViewportRestore = null;
      if (preserveFrame && activeFrameDocument && frameRenderedText === requestText) {
        applyAppearanceToFrame();
      } else {
        renderFrame(requestText, viewportRestore);
      }
    });
  };

  const requestRender = (
    text: string,
    { background = false, force = false, preserveViewport = false, preserveFrame = false }: {
      background?: boolean;
      force?: boolean;
      preserveViewport?: boolean;
      preserveFrame?: boolean;
  } = {}
  ): void => {
    const preserveCurrentFrame = preserveFrame
      && activeFrameDocument !== null
      && frameRenderedText === text;
    if (preserveCurrentFrame) capturePresentationScroll();
    const mutate = () => performRequestRender(text, { background, force, preserveFrame });
    if (preserveViewport && !preserveCurrentFrame) withViewportTransaction(() => mutate());
    else mutate();
  };

  const acceptRenderResponse = (message: PreviewRenderResponse) => (
    disposed ? false : previewRenderTransport.accept(message)
  );

  const updateSourceColoringControl = (): void => {
    sourceColoringSelect.value = String(sourceColoring);
    sourceColoringSelectControl.syncFromSelect();
  };

  const setSourceColoring = (
    enabled: boolean,
    { post = false }: { readonly post?: boolean } = {}
  ): void => {
    if (sourceColoring === enabled) {
      updateSourceColoringControl();
      return;
    }
    sourceColoring = enabled;
    updateSourceColoringControl();
    const text = hasPendingRequest ? pendingText : latestAcceptedText;
    if (text !== null) {
        requestRender(text, { force: true, preserveViewport: true, preserveFrame: true });
    }
    if (post) vscode.postMessage({ type: 'setPreviewSourceColoring', enabled });
  };

  const setFontFamily = (
    value: string,
    { post = false }: { readonly post?: boolean } = {}
  ): void => {
    const nextFontFamily = normalizePreviewFontFamily(value);
    if (disposed || nextFontFamily === null) {
      fontFamilySelect.value = fontFamilyPreference;
      return;
    }
    const changed = fontFamilyPreference !== nextFontFamily;
    fontFamilyPreference = nextFontFamily;
    if (nextFontFamily && !Array.from(fontFamilySelect.options).some((option) => option.value === nextFontFamily)) {
      const option = document.createElement('option');
      option.value = nextFontFamily;
      option.textContent = nextFontFamily;
      fontFamilySelect.append(option);
      fontFamilySelectControl.refreshOptions();
    }
    fontFamilySelect.value = nextFontFamily;
    fontFamilySelectControl.syncFromSelect();
    if (changed && (latestPayload || hasPendingRequest)) {
      const text = hasPendingRequest ? pendingText : latestAcceptedText;
      if (text !== null) {
        requestRender(text, {
          force: true,
          preserveViewport: true,
          preserveFrame: true
        });
      }
    }
    if (changed && post) vscode.postMessage({ type: 'setPreviewFontFamily', fontFamily: nextFontFamily });
  };

  const handleAppearanceControlChange = () => {
    const nextAppearance = appearanceSelect.value;
    if (nextAppearance !== 'auto' && nextAppearance !== 'light' && nextAppearance !== 'dark') {
      return;
    }
    setAppearance(nextAppearance, { post: true });
  };
  appearanceSelect.addEventListener('change', handleAppearanceControlChange);
  const handleSourceColoringChange = () => setSourceColoring(sourceColoringSelect.value === 'true', { post: true });
  sourceColoringSelect.addEventListener('change', handleSourceColoringChange);
  const handleFontFamilyChange = () => setFontFamily(fontFamilySelect.value, { post: true });
  fontFamilySelect.addEventListener('change', handleFontFamilyChange);
  updateThemeToggle();
  updateSourceColoringControl();

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
    let candidate: { element: HTMLElement; start: number; end: number } | null = null;
    for (const element of getSourceElements()) {
      const range = getSourceRange(element);
      if (!range) {
        continue;
      }
      if (line >= range.start && line <= range.end) {
        return { element, ...range };
      }
      if (range.start > line) {
        if (candidate && line - candidate.end <= range.start - line) {
          return candidate;
        }
        return { element, ...range };
      }
      candidate = { element, ...range };
    }
    return candidate;
  };
  const restoreTopLine = (line: number, lineOffset = 0): void => {
    const source = findSourceElement(line);
    const scrollElement = getFrameDocument()?.scrollingElement;
    if (!source || !scrollElement) {
      return;
    }
    const lineSpan = Math.max(1, source.end - source.start + 1);
    const ratio = Math.max(0, Math.min(1, (line - source.start) / lineSpan));
    const rect = source.element.getBoundingClientRect();
    const mappedOffset = line >= source.start && line <= source.end ? Math.max(0, lineOffset) : 0;
    scrollElement.scrollTop += rect.top + rect.height * ratio + mappedOffset;
  };
  const getTopVisiblePosition = (): { topLine: number; topLineOffset: number; editorLineOffset: number } | null => {
    const elements = getSourceElements();
    if (elements.length === 0) {
      return null;
    }
    const viewportAnchor = 0;
    let candidate = elements[0];
    for (const element of elements) {
      // Scroll positions can round a block just below zero at fractional scale.
      if (element.getBoundingClientRect().top > viewportAnchor + 0.5) {
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
    const lineSpan = Math.max(1, range.end - range.start + 1);
    const lineTop = rect.top + rect.height * ((topLine - range.start) / lineSpan);
    return {
      topLine,
      topLineOffset: Math.max(0, viewportAnchor - lineTop),
      // An unmapped Preview gap has no corresponding editor line box.
      editorLineOffset: rect.bottom <= viewportAnchor ? 0 : Math.max(0, viewportAnchor - lineTop)
    };
  };
  const restoreTopVisiblePosition = (
    position: { line: number; lineOffset: number },
    isCurrent: () => boolean
  ): void => {
    const restore = { ...position, isCurrent };
    if (acceptingViewportProjection) acceptingViewportProjection.restore = restore;
    if (hasPendingRequest) {
      pendingViewportRestore = restore;
      if (activeFrameDocument && frameRenderedText !== null && restore.isCurrent()) {
        restoreTopLine(restore.line, restore.lineOffset);
      }
      return;
    }
    if (restore.isCurrent()) restoreTopLine(restore.line, restore.lineOffset);
  };
  const getHeadings = (): OutlineHeading[] => {
    const headingElements = Array.from(
      getFrameDocument()?.querySelectorAll<HTMLElement>('h1[data-source-line], h2[data-source-line], h3[data-source-line], h4[data-source-line], h5[data-source-line], h6[data-source-line]') ?? []
    );
    return headingElements.map((heading) => {
      const line = Number.parseInt(heading.dataset.sourceLine ?? '1', 10);
      return {
        text: heading.textContent?.trim() || uiStrings.untitled,
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
    }
  };

  return {
    host,
    appearanceControl,
    fontFamilyControl,
    sourceColoringControl,
    requestRender,
    preload: (text: string) => requestRender(text, { background: true }),
    acceptRenderResponse,
    setAppearance,
    setSourceColoring,
    setFontFamily,
    setUiLanguage: applyUiLanguage,
    syncAutoAppearance: () => {
      if (appearancePreference === 'auto') setAppearance('auto');
      else {
        applyCodeTheme(appearance);
        updateThemeToggle();
      }
    },
    getAppearance: () => appearance,
    getSourceColoring: () => sourceColoring,
    getStyleEnvironment,
    setVisible: (visible: boolean) => {
      host.hidden = !visible;
      host.inert = !visible;
      if (!visible) cancelPaintReady();
      else if (activeFrameDocument && !hasPendingRequest) schedulePaintReady();
    },
    focus: () => {
      frame.focus();
      frame.contentWindow?.focus();
      frame.contentDocument?.body.focus({ preventScroll: true });
    },
    getTopVisiblePosition,
    restoreTopLine,
    restoreTopVisiblePosition,
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
    getOutlineAdapter: () => outlineAdapter,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelPaintReady();
      cancelHighlightFrame();
      requestGeneration += 1;
      frameGeneration += 1;
      mermaidPresentationGeneration += 1;
      previewMermaidRenderer.dispose();
      unsubscribePreviewCodeHighlight();
      releasePreviewCodeHighlighting();
      activeFrameDocument = null;
      frameRenderedText = null;
      frame.style.removeProperty('visibility');
      hasPendingRequest = false;
      pendingViewportRestore = null;
      previewRenderTransport.cancelAll('Preview closed');
      appearanceSelect.removeEventListener('change', handleAppearanceControlChange);
      sourceColoringSelect.removeEventListener('change', handleSourceColoringChange);
      fontFamilySelect.removeEventListener('change', handleFontFamilyChange);
      appearanceSelectControl.dispose();
      sourceColoringSelectControl.dispose();
      fontFamilySelectControl.dispose();
      frame.onload = null;
      disposePreviewMathViewports();
      disposeDeferredImages();
      scrollToTopController.setScrollElement(null);
      clearSearchMatches();
    }
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
