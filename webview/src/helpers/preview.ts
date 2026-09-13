import morphdom from 'morphdom';
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
import {
  applyPreviewCodeHighlight,
  hasAppliedPreviewCodeHighlight,
  isPreviewCodeHighlightReady
} from './previewCodeHighlight';
import { activateShikiCodeHighlighting, subscribeShikiRefresh } from './shikiHighlighter';
import { createToolbarDropdown } from './toolbarDropdown';
import { resolveEmbeddedImageSrc } from './images';
import {
  createPreviewTableLayoutController,
  type PreviewTableLayoutController
} from './previewTableLayout';

type PreviewControllerOptions = {
  vscode: { postMessage: (message: WebviewMessage) => void };
  uiLanguage: UiLanguage;
  getEditorAppearance: () => 'light' | 'dark';
  isCurrentText?: (text: string) => boolean;
  getCodePalette: (appearance: 'light' | 'dark') => PreviewCodePalette;
  applyCodeTheme: (appearance: 'light' | 'dark') => void;
  onRendered?: (options?: { readonly skipLinkedViewportProjection?: boolean }) => void;
  onPaintReady?: () => void;
  onFindRequested?: () => void;
  onViewportInteraction?: () => void;
  onViewportChange?: () => void;
  onGeometryChanged?: () => void;
  runViewportTransaction?: (
    mutate: () => void,
    documentChange?: { readonly previousText: string; readonly nextText: string }
  ) => void | Promise<void>;
  mermaidRenderResources: MermaidDiagramRenderResources;
};

type PreviewViewportRestore = {
  readonly line: number;
  readonly lineOffset: number;
  readonly viewportOffset?: number;
  readonly sourceRange?: {
    readonly startLine: number;
    readonly endLine: number;
    readonly progress: number;
  };
  readonly isCurrent: () => boolean;
};

type PreviewViewportProjectionSlot = {
  restore: PreviewViewportRestore | null;
};

const previewMutableStateAttributes = new Set([
  'open',
  'data-source-line',
  'data-source-end-line'
]);

function syncSourceMappingAttributes(fromElement: Element, toElement: Element): void {
  for (const attribute of ['data-source-line', 'data-source-end-line']) {
    const value = toElement.getAttribute(attribute);
    if (value === null) fromElement.removeAttribute(attribute);
    else fromElement.setAttribute(attribute, value);
  }
}

function syncDescendantSourceMappings(fromElement: Element, toElement: Element): void {
  syncSourceMappingAttributes(fromElement, toElement);
  const fromMapped = fromElement.querySelectorAll('[data-source-line], [data-source-end-line]');
  const toMapped = toElement.querySelectorAll('[data-source-line], [data-source-end-line]');
  if (fromMapped.length !== toMapped.length) return;
  for (let index = 0; index < fromMapped.length; index += 1) {
    syncSourceMappingAttributes(fromMapped[index], toMapped[index]);
  }
}

function haveEquivalentPreviewAttributes(left: Element, right: Element): boolean {
  let leftCount = 0;
  let rightCount = 0;
  for (const attribute of Array.from(left.attributes)) {
    if (previewMutableStateAttributes.has(attribute.name)) continue;
    leftCount += 1;
    if (right.getAttribute(attribute.name) !== attribute.value) return false;
  }
  for (const attribute of Array.from(right.attributes)) {
    if (!previewMutableStateAttributes.has(attribute.name)) rightCount += 1;
  }
  return leftCount === rightCount;
}

function areEquivalentPreviewNodes(left: Node, right: Node): boolean {
  if (left.nodeType !== right.nodeType) return false;
  if (left.nodeType !== 1) return left.isEqualNode(right);
  const leftElement = left as Element;
  const rightElement = right as Element;
  if (
    leftElement.tagName !== rightElement.tagName
    || !haveEquivalentPreviewAttributes(leftElement, rightElement)
    || leftElement.childNodes.length !== rightElement.childNodes.length
  ) return false;
  for (let index = 0; index < leftElement.childNodes.length; index += 1) {
    if (!areEquivalentPreviewNodes(
      leftElement.childNodes[index],
      rightElement.childNodes[index]
    )) return false;
  }
  return true;
}

function areEquivalentPreviewElements(left: HTMLElement, right: HTMLElement): boolean {
  return areEquivalentPreviewNodes(left, right);
}

function preserveLoadedPreviewImage(fromImage: HTMLImageElement, toImage: HTMLImageElement): boolean {
  const loadedSource = fromImage.dataset.meoPreviewImageSource;
  const nextSource = toImage.dataset.meoDeferredImageSrc;
  if (!loadedSource || loadedSource !== nextSource) return false;
  for (const attribute of Array.from(fromImage.attributes)) {
    if (
      attribute.name !== 'src'
      && attribute.name !== 'data-meo-preview-image-source'
      && !toImage.hasAttribute(attribute.name)
    ) {
      fromImage.removeAttribute(attribute.name);
    }
  }
  for (const attribute of Array.from(toImage.attributes)) {
    if (attribute.name !== 'src' && attribute.name !== 'data-meo-deferred-image-src') {
      fromImage.setAttribute(attribute.name, attribute.value);
    }
  }
  syncSourceMappingAttributes(fromImage, toImage);
  return true;
}

function morphPreviewMain(
  frameDocument: Document,
  currentMain: HTMLElement,
  html: string,
  deferUnreadyCodeBlock: boolean
): boolean {
  const nextMain = frameDocument.createElement('main');
  nextMain.className = 'meo-export-doc';
  nextMain.innerHTML = html;
  const currentTables = Array.from(currentMain.querySelectorAll<HTMLTableElement>('table'));
  Array.from(nextMain.querySelectorAll<HTMLTableElement>('table')).forEach((table, index) => {
    const columns = currentTables[index]
      ?.querySelector<HTMLTableColElement>(':scope > colgroup[data-meo-preview-columns]');
    if (columns) table.prepend(columns.cloneNode(true));
  });
  let deferredCodeBlock = false;
  morphdom(currentMain, nextMain, {
    childrenOnly: true,
    onBeforeElUpdated(fromElement, toElement) {
      if (
        fromElement.tagName === 'IMG'
        && toElement.tagName === 'IMG'
        && preserveLoadedPreviewImage(
          fromElement as HTMLImageElement,
          toElement as HTMLImageElement
        )
      ) {
        return false;
      }
      const mermaidSource = fromElement.dataset.sourceB64;
      if (
        mermaidSource
        && fromElement.classList.contains('meo-export-mermaid')
        && toElement.classList.contains('meo-export-mermaid')
      ) {
        const nextSource = toElement.dataset.sourceB64;
        if (
          nextSource
          && nextSource !== mermaidSource
          && fromElement.classList.contains('is-rendered')
          && fromElement.querySelector('svg')
        ) {
          // Keep the last successful diagram on screen while the replacement is
          // rendered off-layout. The renderer commits the new SVG atomically.
          fromElement.dataset.sourceB64 = nextSource;
          fromElement.dataset.meoPreviewMermaidPending = 'true';
          delete fromElement.dataset.meoPreviewMermaidAppearance;
          syncSourceMappingAttributes(fromElement, toElement);
          return false;
        }
        if (mermaidSource !== nextSource) return true;
        syncSourceMappingAttributes(fromElement, toElement);
        return false;
      }
      if (
        deferUnreadyCodeBlock
        && fromElement.classList.contains('meo-export-code-block-wrap')
        && toElement.classList.contains('meo-export-code-block-wrap')
        && fromElement.textContent !== toElement.textContent
        && hasAppliedPreviewCodeHighlight(fromElement)
        && !isPreviewCodeHighlightReady(toElement)
      ) {
        // Keep the last fully themed block until the replacement tokens exist.
        // The Shiki refresh callback reruns this morph, which then commits the
        // new source and token DOM together before the next visible frame.
        syncSourceMappingAttributes(fromElement, toElement);
        deferredCodeBlock = true;
        return false;
      }
      if (fromElement.tagName === 'DETAILS') {
        toElement.toggleAttribute('open', (fromElement as HTMLDetailsElement).open);
      }
      if (areEquivalentPreviewElements(fromElement, toElement)) {
        syncDescendantSourceMappings(fromElement, toElement);
        return false;
      }
      return true;
    }
  });
  return deferredCodeBlock;
}

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
  scrollbar-color: color-mix(in srgb, var(--meo-fg) 38%, transparent) transparent;
  scrollbar-width: thin;
}

html {
  max-width: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

body {
  max-width: 100%;
  min-width: 0;
  overflow-x: clip;
  scrollbar-gutter: stable;
}

.meo-export-page {
  min-width: 0;
  max-width: 100%;
}

.meo-export-doc {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: normal;
}

.meo-export-math,
.meo-export-math * {
  overflow-wrap: normal;
  word-break: normal;
}

html::-webkit-scrollbar,
body::-webkit-scrollbar {
  -webkit-appearance: none;
  width: 10px !important;
  height: 0 !important;
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

.meo-export-html-block {
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
}

.meo-table-scroll,
.meo-export-html-block.meo-preview-table-only-html {
  max-width: 100%;
  min-width: 0;
  overflow-x: clip;
}

.meo-table-scroll :is(th, td),
.meo-export-html-block.meo-preview-table-only-html :is(th, td) {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.meo-table-scroll :is(pre, code),
.meo-export-html-block.meo-preview-table-only-html :is(pre, code) {
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

table.meo-preview-table-compressed :is(th, td) {
  padding-inline: var(--meo-preview-table-cell-inline-padding) !important;
}

table.meo-preview-table-compressed :is(th, td) :is(ul, ol) {
  box-sizing: border-box;
  max-width: 100%;
  margin-inline: 0;
  padding-inline-start: 0 !important;
  /* At infeasible widths a native list marker has its own unbreakable minimum.
     Keep the cell text visible; semantic list structure remains in the DOM. */
  list-style: none;
}

table.meo-preview-table-compressed :is(th, td) :is(ul, ol, li) {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: normal;
  word-break: break-word;
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
  isCurrentText,
  getCodePalette,
  applyCodeTheme,
  onRendered,
  onPaintReady,
  onFindRequested,
  onViewportInteraction,
  onViewportChange,
  onGeometryChanged,
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
  let acceptingViewportProjection: PreviewViewportProjectionSlot | null = null;
  let pendingText = '';
  let latestAcceptedText: string | null = null;
  let frameRenderedText: string | null = null;
  type PreviewSourceMapEntry = {
    element: HTMLElement;
    start: number;
    end: number;
    top: number;
    bottom: number;
  };
  let sourceMapDocument: Document | null = null;
  let sourceMap: PreviewSourceMapEntry[] = [];
  let sourceMapDirty = true;
  let sourceMapResizeObserver: ResizeObserver | null = null;
  let sourceMapMeasureFrame: number | null = null;
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
  let previewTableLayout: PreviewTableLayoutController | null = null;
  let disposeDeferredImages = () => {};
  let frameEvents: AbortController | null = null;
  let disposed = false;
  let paintFrame: number | null = null;
  let highlightFrame: number | null = null;
  let commitPendingCodeHighlight: (() => void) | null = null;
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
    const pendingCommit = commitPendingCodeHighlight;
    if (pendingCommit) {
      commitPendingCodeHighlight = null;
      pendingCommit();
      return;
    }
    if (!disposed && sourceColoring && activeFrameDocument) {
      applyPreviewCodeHighlight(activeFrameDocument, true);
    }
  }, 'preview');

  const withViewportTransaction = (
    mutate: (slot: PreviewViewportProjectionSlot) => void,
    documentChange?: { readonly previousText: string; readonly nextText: string }
  ): void => {
    const slot: PreviewViewportProjectionSlot = { restore: null };
    const previousSlot = acceptingViewportProjection;
    acceptingViewportProjection = slot;
    try {
      if (runViewportTransaction) runViewportTransaction(() => mutate(slot), documentChange);
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
    const pendingCommits: Array<() => void> = [];
    let commitFrame: number | null = null;
    const flushCommits = () => {
      commitFrame = null;
      if (
        abortController.signal.aborted || disposed ||
        activeFrameDocument !== frameDocument || pendingCommits.length === 0
      ) return;
      const commits = pendingCommits.splice(0);
      const commit = () => {
        for (const mutate of commits) mutate();
        sourceMapDirty = true;
      };
      if (host.hidden) commit();
      else withViewportTransaction(() => commit());
    };
    const enqueueCommit = (commit: () => void) => {
      pendingCommits.push(commit);
      if (commitFrame !== null) return;
      commitFrame = frameDocument.defaultView?.requestAnimationFrame(flushCommits) ?? null;
      if (commitFrame === null) flushCommits();
    };
    const images = Array.from(frameDocument.querySelectorAll<HTMLImageElement>(
      'img[data-meo-deferred-image-src]'
    ));
    const loadImage = async (image: HTMLImageElement) => {
      const rawSrc = image.getAttribute('data-meo-deferred-image-src') ?? '';
      image.removeAttribute('data-meo-deferred-image-src');
      image.dataset.meoPreviewImageSource = rawSrc;
      const resolvedSrc = await resolveEmbeddedImageSrc(rawSrc, abortController.signal);
      if (
        abortController.signal.aborted ||
        disposed ||
        activeFrameDocument !== frameDocument
      ) return;
      if (!resolvedSrc) {
        enqueueCommit(() => image.removeAttribute('src'));
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
      enqueueCommit(() => {
        image.replaceWith(prepared);
      });
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
      pendingCommits.length = 0;
      if (commitFrame !== null) frameDocument.defaultView?.cancelAnimationFrame(commitFrame);
      commitFrame = null;
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

  const setPendingStatus = (background: boolean): void => {
    // Once a usable reading surface exists it is the progress UI. Keeping it
    // unobstructed also avoids turning every coalesced Source edit into a flash.
    const hasReadablePresentation = latestPayload !== null || Boolean(
      frame.contentDocument?.querySelector('main.meo-export-doc')
    );
    setStatus(!background && !hasReadablePresentation ? uiStrings.previewGenerating : null);
  };

  const renderFrame = (renderedText: string, preserveViewport = false) => {
    if (disposed || !latestPayload) {
      return;
    }
    const payload = latestPayload;
    cancelHighlightFrame();
    commitPendingCodeHighlight = null;
    const reusableDocument = activeFrameDocument === frame.contentDocument ? activeFrameDocument : null;
    const reusableMain = reusableDocument?.querySelector<HTMLElement>('main.meo-export-doc');
    const previousRenderedText = frameRenderedText;
    frameEvents?.abort();
    frameEvents = null;
    if (!reusableDocument) {
      searchMatches = [];
      activeSearchIndex = -1;
    }
    const loadGeneration = frameGeneration + 1;
    frameGeneration = loadGeneration;
    mermaidPresentationGeneration += 1;
    activeFrameDocument = null;
    pendingPresentationScroll = null;
    frameRenderedText = null;
    disposeDeferredImages();
    const katexHref = document.body.dataset.meoKatexSrc ?? '';
    const katexInlineStyles = collectPreviewKatexStyles(katexHref).replace(/<\/style/gi, '<\\/style');
    const katexStylesTag = katexInlineStyles
      ? `<style data-meo-preview-katex>${katexInlineStyles}</style>`
      : katexHref
        ? `<link rel="stylesheet" href="${escapeHtmlAttribute(katexHref)}">`
        : '';
    const styles = payload.styles[appearance].replace(/<\/style/gi, '<\\/style');
    const initializeFrame = (viewportSlot: PreviewViewportProjectionSlot | null = null) => {
      if (disposed || loadGeneration !== frameGeneration) return;
      const frameDocument = frame.contentDocument;
      if (!frameDocument) {
        return;
      }
      activeFrameDocument = frameDocument;
      sourceMapDocument = null;
      sourceMap = [];
      sourceMapDirty = true;
      frameEvents = new AbortController();
      const signal = frameEvents.signal;
      frameRenderedText = renderedText;
      sourceMapResizeObserver?.disconnect();
      const FrameResizeObserver = frame.contentWindow
        ? (frame.contentWindow as unknown as Pick<typeof globalThis, 'ResizeObserver'>).ResizeObserver
        : null;
      const mappedRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc');
      if (FrameResizeObserver && mappedRoot) {
        sourceMapResizeObserver = new FrameResizeObserver(() => {
          sourceMapDirty = true;
          if (sourceMapMeasureFrame !== null) return;
          sourceMapMeasureFrame = window.requestAnimationFrame(() => {
            sourceMapMeasureFrame = null;
            if (!disposed && activeFrameDocument === frameDocument) {
              getSourceMap();
              onGeometryChanged?.();
            }
          });
        });
        sourceMapResizeObserver.observe(mappedRoot);
      }
      const styleElement = frameDocument.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
      if (styleElement) styleElement.textContent = payload.styles[appearance];
      previewTableLayout?.dispose();
      previewTableLayout = createPreviewTableLayoutController(frameDocument);
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
        if (!disposed && activeFrameDocument === frameDocument) onViewportChange?.();
      }, { passive: true, signal });
      const notifyViewportInteraction = (event: Event) => {
        if (!event.isTrusted) return;
        if (event.type === 'keydown') {
          const key = (event as KeyboardEvent).key;
          if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) return;
        }
        viewportInteractionGeneration += 1;
        pendingPresentationScroll = null;
        onViewportInteraction?.();
      };
      // Ownership follows gestures that can actually move the reading surface.
      // Selection/focus events may be browser-generated by a DOM replacement and
      // must never turn a presentation update into a reverse linked scroll.
      for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
        frameDocument.addEventListener(type, notifyViewportInteraction, { capture: true, signal });
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
      }, { capture: true, signal });
      bindPreviewLinks(frameDocument, vscode, signal);
      bindPreviewWheelFallback(frameDocument, signal);
      bindPreviewFindShortcut(frameDocument, onFindRequested, signal);
      refreshSearchMatches();
      const keepPosition = () => {
        if (
          disposed ||
          !isCurrent()
        ) return;
        const viewportRestore = viewportSlot?.restore;
        if (viewportRestore?.isCurrent()) {
          restoreTopLine(
            viewportRestore.line,
            viewportRestore.lineOffset,
            viewportRestore.viewportOffset,
            viewportRestore.sourceRange
          );
        }
      };
      const finishRender = () => {
        keepPosition();
        frame.style.removeProperty('visibility');
        scrollToTopController.sync();
        onRendered?.({ skipLinkedViewportProjection: preserveViewport });
        schedulePaintReady();
      };
      finishRender();
      attachDeferredImages(frameDocument);
      if (payload.hasMermaid) {
        void previewMermaidRenderer.render(
          frameDocument,
          appearance,
          () => {
            sourceMapDirty = true;
            scrollToTopController.sync();
          },
          isCurrent,
          (mutate) => {
            const commit = () => {
              mutate();
              sourceMapDirty = true;
            };
            if (host.hidden) commit();
            else withViewportTransaction(() => commit());
          }
        );
      }
    };
    scrollToTopController.setScrollElement(null);
    if (reusableDocument && reusableMain) {
      // Keep the browsing context and unchanged blocks alive. The viewport
      // transaction projects the current driver exactly once after the morph,
      // before the browser can paint the new layout.
      frame.onload = null;
      const commit = (viewportSlot: PreviewViewportProjectionSlot | null) => {
        clearSearchMatches();
        disposePreviewMathViewports();
        reusableDocument.documentElement.lang = uiLanguage;
        const deferredCodeBlock = morphPreviewMain(
          reusableDocument,
          reusableMain,
          payload.html,
          sourceColoring
        );
        if (deferredCodeBlock) {
          commitPendingCodeHighlight = () => {
            if (
              !disposed && activeFrameDocument === reusableDocument
              && latestPayload === payload && frameRenderedText === renderedText
            ) renderFrame(renderedText, true);
          };
        }
        if (!preserveViewport && reusableDocument.scrollingElement) {
          reusableDocument.scrollingElement.scrollTop = 0;
        }
        initializeFrame(viewportSlot);
      };
      if (preserveViewport) {
        withViewportTransaction(
          (slot) => commit(slot),
          previousRenderedText === null
            ? undefined
            : { previousText: previousRenderedText, nextText: renderedText }
        );
      }
      else commit(null);
      return;
    }
    disposePreviewMathViewports();
    previewTableLayout?.dispose();
    previewTableLayout = null;
    frame.onload = () => initializeFrame();
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
    previewTableLayout?.refresh();
    syncPreviewCodeHighlight(frameDocument);
    keepPosition();
    onRendered?.({ skipLinkedViewportProjection: true });
    if (payload.hasMermaid) {
      void previewMermaidRenderer.render(
        frameDocument,
        appearance,
        () => {
          sourceMapDirty = true;
          scrollToTopController.sync();
        },
        isCurrent,
        (mutate) => {
          const commit = () => {
            mutate();
            sourceMapDirty = true;
          };
          if (host.hidden) commit();
          else withViewportTransaction(() => commit());
        }
      );
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
    { background = false, force = false, preserveViewport = false, preserveFrame = false }: {
      background?: boolean;
      force?: boolean;
      preserveViewport?: boolean;
      preserveFrame?: boolean;
    } = {}
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!force
      && latestPayload
      && text === latestAcceptedText
      && text === frameRenderedText
      && frame.contentDocument?.querySelector('.meo-export-doc')) {
      setStatus(null);
      onRendered?.();
      schedulePaintReady();
      return Promise.resolve();
    }
    if (!force && hasPendingRequest && text === pendingText) {
      setPendingStatus(background);
      return Promise.resolve();
    }
    const generation = requestGeneration + 1;
    cancelPaintReady();
    const requestText = text;
    requestGeneration = generation;
    hasPendingRequest = true;
    pendingText = text;
    setPendingStatus(background);
    return previewRenderTransport.render({
      text,
      uiLanguage,
      environment: getStyleEnvironment()
    }).then((result) => {
      if (generation !== requestGeneration) return;
      hasPendingRequest = false;
      // A render may finish after typing or an external update has already
      // produced a newer Draft. Never flash that stale presentation while the
      // single-flight Adapter starts the newest queued render.
      if (isCurrentText?.(requestText) === false) {
        return;
      }
      if (result.ok === false) {
        setStatus(uiStrings.previewFailed);
        schedulePaintReady();
        return;
      }
      latestPayload = result.value;
      latestAcceptedText = requestText;
      setStatus(null);
      if (preserveFrame && activeFrameDocument && frameRenderedText === requestText) {
        applyAppearanceToFrame();
      } else {
        renderFrame(requestText, preserveViewport);
      }
    }).then(() => undefined);
  };

  const requestRender = (
    text: string,
    { background = false, force = false, preserveViewport = false, preserveFrame = false }: {
      background?: boolean;
      force?: boolean;
      preserveViewport?: boolean;
      preserveFrame?: boolean;
  } = {}
  ): Promise<void> => {
    const preserveCurrentFrame = preserveFrame
      && activeFrameDocument !== null
      && frameRenderedText === text;
    if (preserveCurrentFrame) capturePresentationScroll();
    return performRequestRender(text, {
      background,
      force,
      preserveViewport: preserveViewport && !preserveCurrentFrame,
      preserveFrame
    });
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
  const getSourceMap = () => {
    const frameDocument = getFrameDocument();
    if (!frameDocument) return [];
    if (sourceMapDocument !== frameDocument || sourceMapDirty) {
      sourceMapDocument = frameDocument;
      sourceMapDirty = false;
      const scrollTop = frameDocument.scrollingElement?.scrollTop ?? 0;
      sourceMap = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .map((element) => {
          const range = getSourceRange(element);
          if (!range) return null;
          const rect = element.getBoundingClientRect();
          return {
            element,
            ...range,
            top: rect.top + scrollTop,
            bottom: rect.bottom + scrollTop
          };
        })
        .filter((entry): entry is PreviewSourceMapEntry => entry !== null)
        // Source projection and binary search must not inherit DOM order:
        // footnotes and similar semantic blocks intentionally render elsewhere.
        .sort((left, right) => left.start - right.start || right.end - left.end || left.top - right.top);
    }
    return sourceMap;
  };
  const getVisualSourceMap = (): PreviewSourceMapEntry[] => [...getSourceMap()]
    .sort((left, right) => left.top - right.top || left.bottom - right.bottom || left.start - right.start);
  const getSourceElements = (): HTMLElement[] => getSourceMap().map(({ element }) => element);
  const getSourceRange = (element: HTMLElement): { start: number; end: number } | null => {
    const start = Number.parseInt(element.dataset.sourceLine ?? '', 10);
    if (!Number.isFinite(start)) {
      return null;
    }
    const parsedEnd = Number.parseInt(element.dataset.sourceEndLine ?? '', 10);
    return { start, end: Number.isFinite(parsedEnd) ? Math.max(start, parsedEnd) : start };
  };
  const findSourceProjection = (line: number): {
    exact?: PreviewSourceMapEntry;
    before?: PreviewSourceMapEntry;
    after?: PreviewSourceMapEntry;
  } | null => {
    const entries = getSourceMap();
    if (entries.length === 0) return null;
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const entry = entries[middle];
      if (line < entry.start) high = middle - 1;
      else low = middle + 1;
    }
    const before = high >= 0 ? entries[high] : undefined;
    const after = low < entries.length ? entries[low] : undefined;
    if (before && line <= before.end) return { exact: before };
    return { before, after };
  };
  const restoreTopLine = (
    line: number,
    lineOffset = 0,
    viewportOffset = 0,
    sourceRange?: { startLine: number; endLine: number; progress: number }
  ): void => {
    const source = findSourceProjection(line);
    const scrollElement = getFrameDocument()?.scrollingElement;
    if (!scrollElement) {
      return;
    }
    if (sourceRange) {
      const range = getSourceMap()
        .filter(entry => (
          entry.start === sourceRange.startLine && entry.end === sourceRange.endLine
        ))
        .sort((left, right) => (
          Math.abs(left.top - scrollElement.scrollTop) - Math.abs(right.top - scrollElement.scrollTop)
        ))[0];
      if (range) {
        const progress = Math.max(0, Math.min(1, sourceRange.progress));
        scrollElement.scrollTop = range.top
          + (range.bottom - range.top) * progress
          - Math.max(0, viewportOffset);
        return;
      }
    }
    if (!source) return;
    if (source.exact) {
      const lineSpan = Math.max(1, source.exact.end - source.exact.start + 1);
      const ratio = Math.max(0, Math.min(1, (line - source.exact.start) / lineSpan));
      scrollElement.scrollTop = source.exact.top
        + (source.exact.bottom - source.exact.top) * ratio
        + Math.max(0, lineOffset)
        - Math.max(0, viewportOffset);
      return;
    }
    if (source.before && source.after) {
      const lineGap = Math.max(1, source.after.start - source.before.end);
      const ratio = Math.max(0, Math.min(1, (line - source.before.end) / lineGap));
      scrollElement.scrollTop = source.before.bottom
        + (source.after.top - source.before.bottom) * ratio
        - Math.max(0, viewportOffset);
      return;
    }
    const edge = source.before ?? source.after;
    if (edge) scrollElement.scrollTop = edge.top - Math.max(0, viewportOffset);
  };
  const getTopVisiblePosition = (viewportOffset = 0): {
    topLine: number;
    topLineOffset: number;
    editorLineOffset: number;
    viewportOffset: number;
    sourceRange?: { startLine: number; endLine: number; progress: number };
  } | null => {
    const entries = getVisualSourceMap();
    if (entries.length === 0) {
      return null;
    }
    const viewportTop = getFrameDocument()?.scrollingElement?.scrollTop ?? 0;
    const boundedViewportOffset = Math.max(0, viewportOffset);
    const viewportAnchor = viewportTop + boundedViewportOffset;
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].top <= viewportAnchor + 0.5) low = middle + 1;
      else high = middle - 1;
    }
    const candidate = entries[Math.max(0, high)];
    const range = candidate;
    const next = entries[Math.max(0, high) + 1];
    if (candidate.bottom < viewportAnchor && next) {
      if (next.top > viewportAnchor) {
        const gapHeight = Math.max(1, next.top - candidate.bottom);
        const ratio = Math.max(0, Math.min(1, (viewportAnchor - candidate.bottom) / gapHeight));
        return {
          topLine: Math.round(range.end + (next.start - range.end) * ratio),
          topLineOffset: 0,
          editorLineOffset: 0,
          viewportOffset: boundedViewportOffset
        };
      }
    }
    const height = candidate.bottom - candidate.top;
    const ratio = height > 0 ? Math.max(0, Math.min(1, (viewportAnchor - candidate.top) / height)) : 0;
    const topLine = Math.round(range.start + (range.end - range.start) * ratio);
    return {
      topLine,
      topLineOffset: 0,
      editorLineOffset: 0,
      viewportOffset: boundedViewportOffset,
      sourceRange: {
        startLine: range.start,
        endLine: range.end,
        progress: ratio
      }
    };
  };
  const restoreTopVisiblePosition = (
    position: {
      line: number;
      lineOffset: number;
      viewportOffset?: number;
      sourceRange?: { startLine: number; endLine: number; progress: number };
    },
    isCurrent: () => boolean
  ): void => {
    const restore = { ...position, isCurrent };
    if (acceptingViewportProjection) acceptingViewportProjection.restore = restore;
    if (restore.isCurrent()) {
      restoreTopLine(
        restore.line,
        restore.lineOffset,
        restore.viewportOffset,
        restore.sourceRange
      );
    }
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
    getReadingPosition: (viewportRatio: number) => getTopVisiblePosition(
      Math.max(0, frame.contentWindow?.innerHeight ?? host.clientHeight)
        * Math.max(0, Math.min(1, viewportRatio))
    ),
    restoreTopLine,
    restoreTopVisiblePosition,
    captureLinkedGeometry: () => {
      const frameDocument = getFrameDocument();
      const scrollElement = frameDocument?.scrollingElement;
      if (!frameDocument || !scrollElement) return null;
      return {
        regions: getSourceMap().map(entry => ({
          startLine: entry.start,
          endLine: entry.end,
          top: entry.top,
          bottom: entry.bottom
        })),
        maximumScrollTop: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight)
      };
    },
    readScrollTop: () => getFrameDocument()?.scrollingElement?.scrollTop ?? 0,
    writeScrollTop: (scrollTop: number) => {
      const scrollElement = getFrameDocument()?.scrollingElement;
      if (!scrollElement) return;
      const next = Math.max(0, Math.min(
        Number.isFinite(scrollTop) ? scrollTop : 0,
        scrollElement.scrollHeight - scrollElement.clientHeight
      ));
      if (Math.abs(scrollElement.scrollTop - next) > 0.1) scrollElement.scrollTop = next;
    },
    refreshLayout: () => {
      previewTableLayout?.refresh();
      sourceMapDirty = true;
    },
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
      commitPendingCodeHighlight = null;
      sourceMapDocument = null;
      sourceMap = [];
      sourceMapDirty = true;
      sourceMapResizeObserver?.disconnect();
      sourceMapResizeObserver = null;
      if (sourceMapMeasureFrame !== null) window.cancelAnimationFrame(sourceMapMeasureFrame);
      sourceMapMeasureFrame = null;
      frameRenderedText = null;
      frame.style.removeProperty('visibility');
      hasPendingRequest = false;
      previewRenderTransport.cancelAll('Preview closed');
      appearanceSelect.removeEventListener('change', handleAppearanceControlChange);
      sourceColoringSelect.removeEventListener('change', handleSourceColoringChange);
      fontFamilySelect.removeEventListener('change', handleFontFamilyChange);
      appearanceSelectControl.dispose();
      sourceColoringSelectControl.dispose();
      fontFamilySelectControl.dispose();
      frame.onload = null;
      disposePreviewMathViewports();
      previewTableLayout?.dispose();
      previewTableLayout = null;
      frameEvents?.abort();
      frameEvents = null;
      disposeDeferredImages();
      scrollToTopController.setScrollElement(null);
      clearSearchMatches();
    }
  };
}

function bindPreviewFindShortcut(frameDocument: Document, onFindRequested: (() => void) | undefined, signal: AbortSignal): void {
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
  }, { capture: true, signal });
}

function bindPreviewLinks(
  frameDocument: Document,
  vscode: { postMessage: (message: WebviewMessage) => void },
  signal: AbortSignal
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

  frameDocument.addEventListener('click', activateLink, { capture: true, signal });
  frameDocument.addEventListener('auxclick', activateLink, { capture: true, signal });
  frameDocument.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      activateLink(event);
    }
  }, { capture: true, signal });
}

function bindPreviewWheelFallback(frameDocument: Document, signal: AbortSignal): void {
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
  }, { passive: false, signal });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
