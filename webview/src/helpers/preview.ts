import { createElement, Code2, Moon, Sun } from 'lucide';
import { getExportStyleEnvironment } from './export';
import { createPreviewMermaidRenderer } from './previewMermaid';
import { logWebviewRenderError } from './errors';
import { createDocumentScrollToTopController } from './scrollToTop';
import { createSegmentedControl } from './segmentedControl';
import type { OutlineHeading } from './outline';
import type { EditorAppearance as PreviewAppearance } from '../../../src/protocol/editorCommands';
import type { PreviewRenderResponse, PreviewRenderValue } from '../../../src/protocol/previewRender';
import { createPreviewRenderTransport } from '../adapters/previewRenderTransport';
import { attachLatexMathViewport, type LatexMathViewportController } from './latexMathViewport';
import type { MermaidDiagramRenderResources } from '../application/mermaidDiagramRenderResources';
import type { PreviewCodePalette } from '../application/finalCodePalette';
import { normalizePreviewFontFamily } from '../../../src/shared/preview';

type PreviewControllerOptions = {
  vscode: { postMessage: (message: WebviewMessage) => void };
  getEditorAppearance: () => 'light' | 'dark';
  getCodePalette: (appearance: 'light' | 'dark') => PreviewCodePalette;
  onRendered?: () => void;
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

const previewLatexMathViewportStyles = `
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
  getEditorAppearance,
  getCodePalette,
  onRendered,
  onFindRequested,
  onViewportInteraction,
  runViewportTransaction,
  mermaidRenderResources
}: PreviewControllerOptions) {
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
        value: 'auto',
        label: 'Auto'
      },
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
  const sourceColoringControl = document.createElement('button');
  sourceColoringControl.type = 'button';
  sourceColoringControl.className = 'preview-toolbar-action preview-source-coloring';
  sourceColoringControl.title = 'Preview source coloring';
  sourceColoringControl.setAttribute('aria-label', 'Preview source coloring');
  sourceColoringControl.append(
    createElement(Code2, { width: 15, height: 15, 'aria-hidden': 'true' }),
    document.createTextNode('Code colors')
  );
  const fontFamilyControl = document.createElement('label');
  fontFamilyControl.className = 'preview-font-family-control';
  fontFamilyControl.title = 'Preview font family';
  const fontFamilyInput = document.createElement('input');
  fontFamilyInput.className = 'preview-font-family-input';
  fontFamilyInput.type = 'text';
  fontFamilyInput.placeholder = 'VS Code editor font';
  fontFamilyInput.setAttribute('aria-label', 'Preview font family');
  fontFamilyInput.setAttribute('role', 'combobox');
  const fontFamilyOptions = document.createElement('datalist');
  fontFamilyOptions.id = 'meo-preview-font-family-options';
  fontFamilyInput.setAttribute('list', fontFamilyOptions.id);
  fontFamilyControl.append(fontFamilyInput, fontFamilyOptions);

  const status = document.createElement('div');
  status.className = 'preview-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const scrollToTopController = createDocumentScrollToTopController();
  host.append(frame, status, scrollToTopController.button);

  let appearancePreference: PreviewAppearance = 'auto';
  let appearance: 'light' | 'dark' = 'dark';
  let sourceColoring = true;
  let fontFamilyPreference = '';
  let fontEnumerationStarted = false;
  let fontEnumerationGeneration = 0;
  let requestGeneration = 0;
  let frameGeneration = 0;
  let mermaidPresentationGeneration = 0;
  let activeFrameDocument: Document | null = null;
  let hasPendingRequest = false;
  let pendingViewportRestore: PreviewViewportRestore | null = null;
  let acceptingViewportProjection: PreviewViewportProjectionSlot | null = null;
  let pendingText = '';
  let latestRenderedText = '';
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
  let disposed = false;

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

  const updateThemeToggle = () => appearanceSegmentedControl.setActive(appearancePreference);

  const setStatus = (message: string | null) => {
    status.hidden = !message;
    status.textContent = message ?? '';
  };

  const renderFrame = (viewportRestore: PreviewViewportRestore | null = null) => {
    if (disposed || !latestPayload) {
      return;
    }
    const loadGeneration = frameGeneration + 1;
    frameGeneration = loadGeneration;
    mermaidPresentationGeneration += 1;
    activeFrameDocument = null;
    const katexHref = document.body.dataset.meoKatexSrc ?? '';
    const katexInlineStyles = collectPreviewKatexStyles(katexHref).replace(/<\/style/gi, '<\\/style');
    const katexStylesTag = katexInlineStyles
      ? `<style data-meo-preview-katex>${katexInlineStyles}</style>`
      : katexHref
        ? `<link rel="stylesheet" href="${escapeHtmlAttribute(katexHref)}">`
        : '';
    const styles = latestPayload.styles[appearance].replace(/<\/style/gi, '<\\/style');
    frame.onload = () => {
      if (disposed || loadGeneration !== frameGeneration) return;
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }
      activeFrameDocument = frameDocument;
      const styleElement = frameDocument.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
      if (styleElement && latestPayload) styleElement.textContent = latestPayload.styles[appearance];
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
      if (viewportRestore?.isCurrent()) {
        restoreTopLine(viewportRestore.line, viewportRestore.lineOffset);
      }
      const notifyViewportInteraction = (event: Event) => {
        if (event.isTrusted) onViewportInteraction?.();
      };
      for (const type of ['wheel', 'pointerdown', 'keydown', 'beforeinput', 'selectionchange', 'focusin']) {
        frameDocument.addEventListener(type, notifyViewportInteraction, true);
      }
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
        scrollToTopController.sync();
        onRendered?.();
      };
      finishRender();
      if (latestPayload?.hasMermaid) {
        void previewMermaidRenderer.render(frameDocument, appearance, keepPosition, isCurrent).finally(keepPosition);
      }
    };
    disposePreviewMathViewports();
    scrollToTopController.setScrollElement(null);
    frame.srcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexStylesTag}<style data-meo-preview-styles>${styles}</style><style>${previewScrollbarStyles}${previewLatexMathViewportStyles}.meo-export-doc a[data-meo-preview-href]{cursor:pointer}.meo-preview-search-match{background:#e0a800;color:inherit}.meo-preview-search-match.is-active{background:#ff8c00;outline:1px solid currentColor}</style></head><body><div class="meo-export-page"><main class="meo-export-doc">${latestPayload.html}</main></div></body></html>`;
  };

  const applyAppearanceToFrame = () => {
    if (disposed) return;
    const frameDocument = activeFrameDocument;
    const styleElement = frameDocument?.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
    if (!latestPayload || !frameDocument || !styleElement) {
      return;
    }
    const payload = latestPayload;
    withViewportTransaction((slot) => {
      const presentationGeneration = mermaidPresentationGeneration + 1;
      mermaidPresentationGeneration = presentationGeneration;
      const isCurrent = () => (
        !disposed &&
        presentationGeneration === mermaidPresentationGeneration &&
        activeFrameDocument === frameDocument &&
        frame.contentDocument === frameDocument
      );
      styleElement.textContent = payload.styles[appearance];
      const keepPosition = () => {
        const restore = slot.restore;
        if (!isCurrent() || !restore?.isCurrent()) return;
        restoreTopLine(restore.line, restore.lineOffset);
      };
      onRendered?.();
      if (payload.hasMermaid) {
        void previewMermaidRenderer.render(frameDocument, appearance, keepPosition, isCurrent).finally(keepPosition);
      }
    });
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
    appearancePreference = nextAppearance;
    appearance = resolvedAppearance;
    updateThemeToggle();
    if (changed) {
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
    if (!force && latestPayload && text === latestRenderedText && frame.contentDocument?.querySelector('.meo-export-doc')) {
      setStatus(null);
      onRendered?.();
      return;
    }
    if (!force && hasPendingRequest && text === pendingText) {
      if (!background) setStatus('正在生成预览…');
      return;
    }
    const generation = requestGeneration + 1;
    requestGeneration = generation;
    hasPendingRequest = true;
    pendingViewportRestore = null;
    pendingText = text;
    if (!background) setStatus('正在生成预览…');
    void previewRenderTransport.render({
      text,
      environment: getStyleEnvironment()
    }).then((result) => {
      if (generation !== requestGeneration) return;
      hasPendingRequest = false;
      if (result.ok === false) {
        pendingViewportRestore = null;
        setStatus(result.error.message || 'Preview 生成失败');
        return;
      }
      latestPayload = result.value;
      latestRenderedText = pendingText;
      setStatus(null);
      const viewportRestore = pendingViewportRestore;
      pendingViewportRestore = null;
      if (preserveFrame && activeFrameDocument) applyAppearanceToFrame();
      else renderFrame(viewportRestore);
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
    const mutate = () => performRequestRender(text, { background, force, preserveFrame });
    if (preserveViewport) withViewportTransaction(() => mutate());
    else mutate();
  };

  const acceptRenderResponse = (message: PreviewRenderResponse) => (
    disposed ? false : previewRenderTransport.accept(message)
  );

  const updateSourceColoringControl = (): void => {
    sourceColoringControl.classList.toggle('is-active', sourceColoring);
    sourceColoringControl.setAttribute('aria-pressed', String(sourceColoring));
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
    if (latestPayload) {
      const text = pendingText || latestRenderedText;
      latestRenderedText = '';
      requestRender(text, { force: true, preserveViewport: true });
    }
    if (post) vscode.postMessage({ type: 'setPreviewSourceColoring', enabled });
  };

  const setFontFamily = (
    value: string,
    { post = false }: { readonly post?: boolean } = {}
  ): void => {
    const nextFontFamily = normalizePreviewFontFamily(value);
    if (disposed || nextFontFamily === null) {
      fontFamilyInput.value = fontFamilyPreference;
      return;
    }
    const changed = fontFamilyPreference !== nextFontFamily;
    fontFamilyPreference = nextFontFamily;
    fontFamilyInput.value = nextFontFamily;
    if (changed && (latestPayload || hasPendingRequest)) {
      requestRender(pendingText || latestRenderedText, {
        force: true,
        preserveViewport: true,
        preserveFrame: true
      });
    }
    if (changed && post) vscode.postMessage({ type: 'setPreviewFontFamily', fontFamily: nextFontFamily });
  };

  const enumerateLocalFontFamilies = (event: Event): void => {
    if (disposed || fontEnumerationStarted || !event.isTrusted || navigator.userActivation?.isActive !== true) return;
    fontEnumerationStarted = true;
    const queryLocalFonts = (window as unknown as {
      queryLocalFonts?: () => Promise<readonly { family?: unknown }[]>;
    }).queryLocalFonts;
    if (typeof queryLocalFonts !== 'function') {
      fontFamilyControl.title = 'Local font list unavailable; type a family name';
      return;
    }
    const generation = ++fontEnumerationGeneration;
    let query: Promise<readonly { family?: unknown }[]>;
    try {
      query = Promise.resolve(queryLocalFonts.call(window));
    } catch {
      fontFamilyControl.title = 'Local font list unavailable; type a family name';
      return;
    }
    void query.then((fonts) => {
      if (disposed || generation !== fontEnumerationGeneration) return;
      const families = new Map<string, string>();
      for (const font of Array.isArray(fonts) ? fonts : []) {
        const family = normalizePreviewFontFamily(font?.family);
        if (!family) continue;
        const key = family.toLocaleLowerCase();
        if (!families.has(key)) families.set(key, family);
      }
      const fragment = document.createDocumentFragment();
      for (const family of [...families.values()].sort((left, right) => left.localeCompare(right))) {
        const option = document.createElement('option');
        option.value = family;
        fragment.append(option);
      }
      fontFamilyOptions.replaceChildren(fragment);
      if (families.size === 0) {
        fontFamilyControl.title = 'Local font list unavailable; type a family name';
      }
    }).catch(() => {
      if (!disposed && generation === fontEnumerationGeneration) {
        fontFamilyControl.title = 'Local font list unavailable; type a family name';
      }
    });
  };

  const handleAppearanceControlClick = (event: Event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.preview-appearance-button[data-appearance]')
      : null;
    const nextAppearance = button?.dataset.appearance;
    if (nextAppearance !== 'auto' && nextAppearance !== 'light' && nextAppearance !== 'dark') {
      return;
    }
    setAppearance(nextAppearance, { post: true });
  };
  appearanceControl.addEventListener('click', handleAppearanceControlClick);
  const handleSourceColoringClick = () => setSourceColoring(!sourceColoring, { post: true });
  sourceColoringControl.addEventListener('click', handleSourceColoringClick);
  const handleFontFamilyInput = () => setFontFamily(fontFamilyInput.value, { post: true });
  fontFamilyInput.addEventListener('input', handleFontFamilyInput);
  fontFamilyInput.addEventListener('pointerdown', enumerateLocalFontFamilies);
  fontFamilyInput.addEventListener('keydown', enumerateLocalFontFamilies);
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
  const getTopVisiblePosition = (): { topLine: number; topLineOffset: number } | null => {
    const elements = getSourceElements();
    if (elements.length === 0) {
      return null;
    }
    const viewportAnchor = 0;
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
    const lineSpan = Math.max(1, range.end - range.start + 1);
    const lineTop = rect.top + rect.height * ((topLine - range.start) / lineSpan);
    const semanticLineHeight = rect.height / lineSpan;
    return {
      topLine,
      topLineOffset: rect.bottom > viewportAnchor
        ? Math.max(0, Math.min(semanticLineHeight, viewportAnchor - lineTop))
        : 0
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
    syncAutoAppearance: () => {
      if (appearancePreference === 'auto') setAppearance('auto');
    },
    getAppearance: () => appearance,
    getSourceColoring: () => sourceColoring,
    getStyleEnvironment,
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
      requestGeneration += 1;
      frameGeneration += 1;
      mermaidPresentationGeneration += 1;
      previewMermaidRenderer.dispose();
      activeFrameDocument = null;
      hasPendingRequest = false;
      pendingViewportRestore = null;
      previewRenderTransport.cancelAll('Preview closed');
      appearanceControl.removeEventListener('click', handleAppearanceControlClick);
      sourceColoringControl.removeEventListener('click', handleSourceColoringClick);
      fontFamilyInput.removeEventListener('input', handleFontFamilyInput);
      fontFamilyInput.removeEventListener('pointerdown', enumerateLocalFontFamilies);
      fontFamilyInput.removeEventListener('keydown', enumerateLocalFontFamilies);
      fontEnumerationGeneration += 1;
      frame.onload = null;
      disposePreviewMathViewports();
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
