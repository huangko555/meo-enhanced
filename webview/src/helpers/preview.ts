import morphdom from 'morphdom';
import { createPreviewSearchController, previewSearchStyles } from './previewSearch';
import { createElement as createIconElement, TextCursor, BookOpen, FileText, Check, Plus } from 'lucide';
import previewPresetBrandIcons from './previewPresetBrandIcons.json';
import { getExportStyleEnvironment } from './export';
import { documentSurfaceVariables } from '../../../src/shared/documentSurfaceRoles';
import { createPreviewMermaidRenderer } from './previewMermaid';
import { createCopyCodeButton } from './codeBlockControls';
import { logWebviewRenderError } from './errors';
import { normalizeDocumentText } from '../../../src/foundation/documentText';
import { assessLargeDocument } from '../../../src/foundation/largeDocument';
import { createDocumentScrollToTopController } from './scrollToTop';
import type { OutlineHeading } from './outline';
import type { EditorAppearance as PreviewAppearance } from '../../../src/protocol/editorCommands';
import type { PreviewRenderResponse, PreviewRenderValue } from '../../../src/protocol/previewRender';
import { createPreviewRenderTransport } from '../adapters/previewRenderTransport';
import { attachLatexMathViewport, type LatexMathViewportController } from './latexMathViewport';
import type { MermaidDiagramRenderResources } from '../application/mermaidDiagramRenderResources';
import type { PreviewCodePalette } from '../application/finalCodePalette';
import { normalizePreviewFontFamily } from '../../../src/shared/preview';
import { decodePreviewPresetState, getPresetInitialAppearance, getPreviewPreset, getPreviewPresetCodeTheme, isPreviewPresetId, isPreviewPresetEnabled, previewPresets, replaceCustomPreviewPresets, normalizePresetAppearance, resolvePresetAppearance, type PreviewPresetDefinition, type PreviewPresetId, type PreviewContentWidth, type PreviewPresetState, type PreviewPresetPreferencePatch } from '../../../src/foundation/previewPresets';
import githubLightTheme from '@shikijs/themes/github-light-default';
import githubDarkTheme from '@shikijs/themes/github-dark-default';
import lightPlusTheme from '@shikijs/themes/light-plus';
import darkPlusTheme from '@shikijs/themes/dark-plus';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import {
  applyPreviewCodeHighlight,
  hasAppliedPreviewCodeHighlight,
  isPreviewCodeHighlightReady
} from './previewCodeHighlight';
import { activateShikiCodeHighlighting, subscribeShikiRefresh, setShikiTheme, type RawVscodeTheme } from './shikiHighlighter';
import { createToolbarDropdown } from './toolbarDropdown';
import { createPreviewFontPicker } from '../adapters/previewFontPicker';
import { fallbackPreviewFonts, type PreviewFont } from '../../../src/foundation/previewFonts';
import { createSegmentedControl } from '../adapters/segmentedControl';
import { createPreviewPresetInfo } from '../adapters/previewPresetInfo';
import type { PreviewPresetDiagnostic } from '../../../src/foundation/previewPresets';
import { resolveEmbeddedImageSrc } from './images';
import { githubPictureMedia } from '../../../src/shared/githubPicture';
import {
  createPreviewTableLayoutController,
  type PreviewTableLayoutController
} from './previewTableLayout';

type PreviewControllerOptions = {
  vscode: { postMessage: (message: WebviewMessage) => void };
  uiLanguage: UiLanguage;
  getEditorAppearance: () => 'light' | 'dark';
  /** Compares LF-normalized presentation text with the current Draft. */
  isCurrentText?: (text: string) => boolean;
  getCodePalette: (appearance: 'light' | 'dark') => PreviewCodePalette;
  applyCodeTheme: (appearance: 'light' | 'dark') => void;
  onPresetPreferencesChanged?: () => void;
  onManagePresets?: () => void;
  /** The shared menu is portaled outside the preview and needs its resolved palette. */
  optionsMenu?: HTMLElement;
  requestFonts?: (refresh: boolean) => Promise<readonly PreviewFont[] | null>;
  onRendered?: (options?: { readonly skipLinkedViewportProjection?: boolean }) => void;
  onPaintReady?: () => void;
  /** Publishes final document colors, including CSS-only background updates. */
  onPaletteChanged?: () => void;
  /** Return true for a handled global command; other command keys continue to VS Code. */
  onShortcut?: (event: KeyboardEvent) => boolean;
  onSearchResultsChanged?: () => void;
  onNavigateToTop?: () => boolean;
  onAlignViewport?: (owner: 'source' | 'preview') => void;
  onViewportInteraction?: (owner: 'source' | 'preview') => void;
  onViewportChange?: () => void;
  onGeometryChanged?: () => void;
  runViewportTransaction?: (
    mutate: () => void,
    documentChange?: { readonly previousText: string; readonly nextText: string }
  ) => void | Promise<void>;
  mermaidRenderResources: MermaidDiagramRenderResources;
};

type PreviewViewportPosition = {
  readonly line: number;
  readonly lineOffset: number;
  readonly viewportOffset?: number;
  readonly sourceRange?: {
    readonly startLine: number;
    readonly endLine: number;
    readonly progress: number;
  };
};

type PreviewViewportRestore = PreviewViewportPosition & {
  readonly isCurrent: () => boolean;
};

type PendingExternalViewportRestore = {
  readonly restore: PreviewViewportRestore;
  readonly requestGeneration: number;
};

type PreviewViewportProjectionSlot = {
  restore: PreviewViewportRestore | null;
};

type PreviewSourcePositionMarkerState = {
  readonly visible: boolean;
  readonly line: number;
  readonly active: boolean;
};

const previewMutableStateAttributes = new Set([
  'open',
  'data-source-line',
  'data-source-end-line'
]);

const previewPresentationSelector = [
  '.meo-export-mermaid[data-source-b64]',
  '.meo-export-math-display',
  '.meo-export-math-inline'
].join(', ');
const previewPresentationMorphKeyAttribute = 'data-meo-preview-morph-key';

function isPreviewMathElement(element: Element): boolean {
  return element.classList.contains('meo-export-math-display')
    || element.classList.contains('meo-export-math-inline');
}

function getPreviewPresentationSignature(element: Element): string | null {
  if (element.classList.contains('meo-export-mermaid')) {
    const source = element.getAttribute('data-source-b64');
    return source ? `mermaid:${source}` : null;
  }
  if (!isPreviewMathElement(element)) return null;
  const layout = element.classList.contains('meo-export-math-display') ? 'display' : 'inline';
  const fenced = element.classList.contains('meo-export-math-fenced-display') ? ':fenced' : '';
  const canvas = element.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas');
  const source = element.getAttribute('data-source-b64');
  return `math:${layout}${fenced}:${source ?? canvas?.innerHTML ?? element.innerHTML}`;
}

function preparePreviewPresentationMorphKeys(
  currentMain: HTMLElement,
  nextMain: HTMLElement
): () => void {
  const available = new Map<string, HTMLElement[]>();
  for (const element of Array.from(currentMain.querySelectorAll<HTMLElement>(previewPresentationSelector))) {
    const signature = getPreviewPresentationSignature(element);
    if (!signature) continue;
    const matches = available.get(signature);
    if (matches) matches.push(element);
    else available.set(signature, [element]);
  }

  const keyedCurrent: HTMLElement[] = [];
  let pairIndex = 0;
  for (const element of Array.from(nextMain.querySelectorAll<HTMLElement>(previewPresentationSelector))) {
    const signature = getPreviewPresentationSignature(element);
    const current = signature ? available.get(signature)?.shift() : undefined;
    if (!current) continue;
    const key = `meo-preview-presentation-${pairIndex += 1}`;
    current.setAttribute(previewPresentationMorphKeyAttribute, key);
    element.setAttribute(previewPresentationMorphKeyAttribute, key);
    keyedCurrent.push(current);
  }

  return () => {
    for (const element of keyedCurrent) element.removeAttribute(previewPresentationMorphKeyAttribute);
  };
}

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

function haveEquivalentPreviewAttributes(left: Element, right: Element, preserveCodeLine = false): boolean {
  let leftCount = 0;
  let rightCount = 0;
  for (const attribute of Array.from(left.attributes)) {
    if (previewMutableStateAttributes.has(attribute.name)
      || (preserveCodeLine && attribute.name === 'data-meo-shiki')) continue;
    leftCount += 1;
    if (right.getAttribute(attribute.name) !== attribute.value) return false;
  }
  for (const attribute of Array.from(right.attributes)) {
    if (!previewMutableStateAttributes.has(attribute.name)
      && !(preserveCodeLine && attribute.name === 'data-meo-shiki')) rightCount += 1;
  }
  return leftCount === rightCount;
}

function areEquivalentPreviewNodes(left: Node, right: Node, preserveCodeHighlight = false): boolean {
  if (left.nodeType !== right.nodeType) return false;
  if (left.nodeType !== 1) return left.isEqualNode(right);
  const leftElement = left as Element;
  const rightElement = right as Element;
  const preserveCodeLine = preserveCodeHighlight
    && leftElement.classList.contains('meo-export-code-line-source')
    && rightElement.classList.contains('meo-export-code-line-source')
    && leftElement.hasAttribute('data-meo-shiki');
  if (
    leftElement.tagName !== rightElement.tagName
    || !haveEquivalentPreviewAttributes(leftElement, rightElement, preserveCodeLine)
  ) return false;
  if (preserveCodeLine) return leftElement.textContent === rightElement.textContent;
  if (leftElement.childNodes.length !== rightElement.childNodes.length) return false;
  for (let index = 0; index < leftElement.childNodes.length; index += 1) {
    if (!areEquivalentPreviewNodes(
      leftElement.childNodes[index],
      rightElement.childNodes[index],
      preserveCodeHighlight
    )) return false;
  }
  return true;
}

function areEquivalentPreviewElements(left: HTMLElement, right: HTMLElement): boolean {
  if (left.isEqualNode(right)) return true;
  // Host fallback spans differ from the themed token DOM. Retain that projection
  // only beneath an equivalent code root, so language/structure changes still morph.
  return areEquivalentPreviewNodes(left, right, left.matches('code.hljs') && right.matches('code.hljs'));
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

// These reading controls are added only to the iframe DOM, never to shared export HTML.
const previewCopyBlockSelector = '.meo-export-code-block-wrap, .meo-export-mermaid, .meo-export-math-display';

function addPreviewCodeCopyControls(root: ParentNode, language: UiLanguage): void {
  const strings = getUiStrings(language);
  for (const block of root.querySelectorAll<HTMLElement>(previewCopyBlockSelector)) {
    if (block.classList.contains('meo-export-mermaid')
      && !block.querySelector(':scope > .meo-export-code-language-label')) {
      const label = block.ownerDocument.createElement('div');
      label.className = 'meo-export-code-language-label';
      label.textContent = 'mermaid';
      block.prepend(label);
    }
    const code = block.querySelector<HTMLElement>(':scope > pre > code');
    if (!code && block.dataset.sourceB64 === undefined) continue;
    let button = block.querySelector<HTMLElement>(':scope > .meo-preview-code-actions > .meo-copy-code-btn');
    if (!button) {
      const copyButton = createCopyCodeButton(() => {
        // Resolve the live DOM after incremental updates and Shiki token projection.
        const currentBlock = copyButton.closest<HTMLElement>(previewCopyBlockSelector);
        if (currentBlock?.dataset.sourceB64 !== undefined) {
          const binary = window.atob(currentBlock.dataset.sourceB64);
          const source = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
          // Mermaid's render payload includes the structural newline before its fence.
          return currentBlock.classList.contains('meo-export-mermaid') ? source.replace(/\n$/, '') : source;
        }
        const currentCode = currentBlock?.querySelector(':scope > pre > code');
        if (!currentCode) return '';
        const lines = Array.from(currentCode.querySelectorAll('.meo-export-code-line-source'));
        return lines.map(line => line.textContent ?? '').join('\n');
      }, language, block.ownerDocument);
      // A mouse click must not collapse the reader's existing text selection.
      copyButton.addEventListener('mousedown', event => {
        if (event.button === 0) event.preventDefault();
      });
      const actions = block.ownerDocument.createElement('span');
      actions.className = 'meo-preview-code-actions';
      actions.append(copyButton);
      block.append(actions);
      button = copyButton;
    }
    button.dataset.tooltip = strings.copyCode;
    button.setAttribute('aria-label', strings.copyCode);
  }
}

const previewCodeCopyStyles = `
.meo-export-mermaid, .meo-export-math-display { position: relative; }
.meo-export-mermaid { padding-block: 24px; }
.meo-preview-code-actions {
  position: absolute; top: 4px; right: 5px; z-index: 10;
  display: inline-flex; align-items: center; gap: 3px; cursor: default; user-select: none;
  opacity: 0; pointer-events: none;
}
:is(.meo-export-code-block-wrap, .meo-export-mermaid, .meo-export-math-display):hover > .meo-preview-code-actions,
.meo-preview-code-actions:focus-within { opacity: 1; pointer-events: auto; }
.meo-preview-code-actions > .meo-copy-code-btn {
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; width: 22px; height: 20px; padding: 0; border: 0; border-radius: 6px;
  cursor: pointer; color: var(--meo-preview-code-copy-fg, var(--meo-fg)); background: var(--meo-preview-code-copy-bg, transparent);
}
.meo-preview-code-actions > .meo-copy-code-btn:is(:hover, :focus-visible) {
  color: var(--meo-preview-code-copy-hover-fg, var(--meo-fg));
  background: var(--meo-preview-code-copy-hover-bg, color-mix(in srgb, var(--meo-fg) 12%, var(--meo-bg)));
}
.meo-preview-code-actions > .meo-copy-code-btn:focus-visible {
  outline: 1px solid var(--meo-preview-code-copy-hover-fg, var(--meo-fg)); outline-offset: 1px;
}
.meo-preview-code-actions svg { display: block; }
@media print { .meo-preview-code-actions { display: none; } }
`;

type PreviewCodeBlockUpdate = {
  readonly current: HTMLElement;
  readonly next: HTMLElement;
};

function morphPreviewMain(
  frameDocument: Document,
  currentMain: HTMLElement,
  html: string,
  deferUnreadyCodeBlock: boolean,
  pendingCodeBlocks: readonly PreviewCodeBlockUpdate[] | undefined,
  isCurrent: () => boolean,
  retainTableColumns = true
): PreviewCodeBlockUpdate[] {
  const updates: PreviewCodeBlockUpdate[] = pendingCodeBlocks ? [...pendingCodeBlocks] : [];
  let clearPresentationMorphKeys = () => {};
  if (!pendingCodeBlocks) {
    const nextMain = frameDocument.createElement('main');
    nextMain.className = 'meo-export-doc';
    nextMain.innerHTML = html;
    addPreviewCodeCopyControls(nextMain, frameDocument.documentElement.lang as UiLanguage);
    const currentTables = retainTableColumns ? Array.from(currentMain.querySelectorAll<HTMLTableElement>('table')) : [];
    Array.from(nextMain.querySelectorAll<HTMLTableElement>('table')).forEach((table, index) => {
      const columns = currentTables[index]
        ?.querySelector<HTMLTableColElement>(':scope > colgroup[data-meo-preview-columns]');
      if (columns) table.prepend(columns.cloneNode(true));
    });
    clearPresentationMorphKeys = preparePreviewPresentationMorphKeys(currentMain, nextMain);
    updates.push({ current: currentMain, next: nextMain });
  }
  const deferredCodeBlocks: PreviewCodeBlockUpdate[] = [];
  try {
    for (const { current, next } of updates) {
      if (!currentMain.contains(current)) continue;
      morphdom(current, next, {
        childrenOnly: !pendingCodeBlocks,
        getNodeKey(node) {
          if (node.nodeType !== 1) return undefined;
          const element = node as Element;
          // Cached overlay references must never be repurposed as document blocks.
          const overlay = ['meo-preview-source-position-marker']
            .find(className => element.classList.contains(className));
          if (overlay) return overlay;
          return element.getAttribute(previewPresentationMorphKeyAttribute) ?? (element.id || undefined);
        },
        onBeforeElUpdated(fromElement, toElement) {
          if (
            fromElement.classList.contains('meo-preview-code-actions')
            && toElement.classList.contains('meo-preview-code-actions')
          ) return false;
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
          const fromPresentation = getPreviewPresentationSignature(fromElement);
          if (
            fromPresentation?.startsWith('math:')
            && fromPresentation === getPreviewPresentationSignature(toElement)
          ) {
            syncSourceMappingAttributes(fromElement, toElement);
            return false;
          }
          if (
            deferUnreadyCodeBlock
            && fromElement.classList.contains('meo-export-code-block-wrap')
            && toElement.classList.contains('meo-export-code-block-wrap')
            && fromElement.textContent !== toElement.textContent
            && hasAppliedPreviewCodeHighlight(fromElement)
            && !isPreviewCodeHighlightReady(toElement, isCurrent)
          ) {
            // Keep the last fully themed block until the replacement tokens exist.
            // The Shiki refresh callback revisits only this block and commits the
            // new source and token DOM together before the next visible frame.
            syncSourceMappingAttributes(fromElement, toElement);
            deferredCodeBlocks.push({ current: fromElement, next: toElement });
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
    }
  } finally {
    clearPresentationMorphKeys();
  }
  // A pending block must not retain the rest of the detached document tree.
  for (const { next } of deferredCodeBlocks) next.remove();
  return deferredCodeBlocks;
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
  scrollbar-color: color-mix(in srgb, var(--meo-fg) 38%, transparent) var(--meo-bg);
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
  position: relative;
  isolation: isolate;
  min-width: 0;
  max-width: 100%;
}

.meo-export-doc {
  isolation: isolate;
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
  background: var(--meo-bg) !important;
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
  background: var(--meo-bg) !important;
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

table.meo-preview-table-compressed :is(th, td):has(code:not(pre code)) {
  /* Cloned inline-code padding can paint past a wrapped fragment's text width.
     Reserve its end inset rather than clipping the background or shrinking it. */
  padding-inline-end: max(var(--meo-preview-table-cell-inline-padding), 0.25em) !important;
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

const previewSourcePositionMarkerStyles = `
.meo-preview-source-position-marker {
  position: absolute;
  z-index: -1;
  left: 0;
  width: 100%;
  min-height: 1px;
  background: color-mix(in srgb, var(--meo-preview-foreground, var(--meo-fg)) 6%, var(--meo-preview-background, var(--meo-bg)));
  pointer-events: none;
}

.meo-preview-source-position-marker[hidden] {
  display: none;
}

.meo-preview-source-position-rail {
  display: none;
}

.meo-preview-source-position-cursor {
  display: none;
}

.meo-preview-source-position-cursor svg {
  display: block;
  width: 16px;
  height: 16px;
  stroke-width: 1.8;
}

@media (forced-colors: active) {
  .meo-preview-source-position-marker {
    background: Highlight;
    opacity: 0.18;
    forced-color-adjust: none;
  }
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

.meo-export-math-display.meo-math-reflow > .meo-latex-math-canvas { width: 100%; }
.meo-export-math-display.meo-math-reflow > .meo-latex-math-canvas > .katex-display { width: auto; }
.meo-export-math-display .katex-display > .katex { white-space: normal; }
.meo-export-math-display .katex-html > .tag { white-space: nowrap; }
.meo-export-math-display.meo-math-nowrap .katex-display > .katex { white-space: nowrap; }

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
  uiLanguage: initialUiLanguage,
  getEditorAppearance,
  isCurrentText,
  getCodePalette,
  applyCodeTheme,
  onPresetPreferencesChanged,
  onManagePresets,
  optionsMenu,
  requestFonts,
  onRendered,
  onPaintReady,
  onPaletteChanged,
  onShortcut,
  onSearchResultsChanged,
  onNavigateToTop,
  onAlignViewport,
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

  const appearanceControl = document.createElement('div');
  appearanceControl.className = 'preview-select-control preview-setting-control preview-appearance-control';
  const appearanceLabel = document.createElement('span');
  appearanceLabel.className = 'preview-select-label';
  appearanceLabel.textContent = uiStrings.previewAppearance;
  const appearanceSelect = document.createElement('select');
  appearanceSelect.className = 'preview-toolbar-native-select preview-appearance-select';
  appearanceSelect.setAttribute('aria-hidden', 'true');
  appearanceSelect.tabIndex = -1;
  for (const value of ['auto', 'light', 'dark'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'auto' ? uiStrings.auto : value === 'light' ? uiStrings.light : uiStrings.dark;
    appearanceSelect.append(option);
  }
  const appearanceSegments = createSegmentedControl<PreviewAppearance>({
    ariaLabel: uiStrings.previewAppearance,
    className: 'preview-setting-segmented',
    buttonClassName: 'preview-setting-button',
    datasetKey: 'previewAppearanceChoice',
    role: 'group',
    buttonTitles: false,
    options: [
      { value: 'auto', label: uiStrings.auto },
      { value: 'light', label: uiStrings.light },
      { value: 'dark', label: uiStrings.dark }
    ]
  });
  appearanceControl.append(appearanceLabel, appearanceSegments.element, appearanceSelect);

  const sourceColoringControl = document.createElement('div');
  sourceColoringControl.className = 'preview-select-control preview-setting-control preview-source-coloring';
  const sourceColoringLabel = document.createElement('span');
  sourceColoringLabel.className = 'preview-select-label';
  sourceColoringLabel.textContent = uiStrings.previewCodeColors;
  const sourceColoringSelect = document.createElement('select');
  sourceColoringSelect.className = 'preview-toolbar-native-select preview-source-coloring-select';
  sourceColoringSelect.setAttribute('aria-hidden', 'true');
  sourceColoringSelect.tabIndex = -1;
  for (const enabled of [true, false]) {
    const option = document.createElement('option');
    option.value = String(enabled);
    option.textContent = enabled ? uiStrings.previewCodeColorsOn : uiStrings.previewCodeColorsOff;
    sourceColoringSelect.append(option);
  }
  const sourceColoringSegments = createSegmentedControl<'true' | 'false'>({
    ariaLabel: uiStrings.previewCodeColors,
    className: 'preview-setting-segmented',
    buttonClassName: 'preview-setting-button',
    datasetKey: 'previewSourceColoring',
    role: 'group',
    buttonTitles: false,
    options: [
      { value: 'true', label: uiStrings.previewCodeColorsOn },
      { value: 'false', label: uiStrings.previewCodeColorsOff }
    ]
  });
  sourceColoringControl.append(sourceColoringLabel, sourceColoringSegments.element, sourceColoringSelect);
  const showCommentsControl = document.createElement('div');
  showCommentsControl.className = 'preview-select-control preview-setting-control preview-show-comments';
  const showCommentsLabel = document.createElement('span');
  showCommentsLabel.className = 'preview-select-label';
  showCommentsLabel.textContent = uiStrings.showComments;
  const showCommentsSegments = createSegmentedControl<'true' | 'false'>({
    ariaLabel: uiStrings.showComments,
    className: 'preview-setting-segmented',
    buttonClassName: 'preview-setting-button',
    datasetKey: 'previewComments',
    role: 'group',
    buttonTitles: false,
    options: [
      { value: 'true', label: uiStrings.previewCommentsShow },
      { value: 'false', label: uiStrings.previewCommentsHide }
    ]
  });
  showCommentsControl.append(showCommentsLabel, showCommentsSegments.element);
  const fontFamilySelectControl = createPreviewFontPicker('preview-font-family-control', uiStrings.previewFontFamily, refresh => { void loadFonts(refresh); });
  const codeFontFamilySelectControl = createPreviewFontPicker('preview-code-font-family-control', uiStrings.previewCodeFontFamily, refresh => { void loadFonts(refresh); });
  const codeFontFamilyControl = codeFontFamilySelectControl.element;
  const codeFontFamilySelect = codeFontFamilySelectControl.select;
  codeFontFamilySelect.classList.add('preview-code-font-family-select');
  const fontFamilyControl = fontFamilySelectControl.element;
  const presetSelectControl = createToolbarDropdown('preview-preset-control', uiStrings.previewPreset);
  const presetControl = presetSelectControl.element;
  const presetSelect = presetSelectControl.select;
  const createPresetIcon = (preset: PreviewPresetId) => {
    if (preset === 'newsprint' || preset === 'whitey' || preset === 'obsidian-minimal') {
      // Official app marks are bundled for offline use; sources are recorded in THIRD_PARTY_NOTICES.md.
      const icon = document.createElement('img');
      icon.width = 15;
      icon.height = 15;
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      icon.src = previewPresetBrandIcons[preset === 'obsidian-minimal' ? 'obsidian' : 'typora'];
      icon.dataset.previewPresetIcon = preset;
      return icon;
    }
    const icon = preset === 'github-readme'
    // GitHub's Octicons mark-github-16; license recorded in THIRD_PARTY_NOTICES.md.
    ? createIconElement([['path', {
      d: 'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656'
    }]], { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'currentColor', stroke: 'none', 'aria-hidden': 'true' })
    : createIconElement(preset === 'default' ? BookOpen : FileText, { width: 15, height: 15, 'aria-hidden': 'true' });
    icon.dataset.previewPresetIcon = preset;
    return icon;
  };
  const presetHeading = document.createElement('span');
  presetHeading.className = 'preview-preset-heading';
  presetHeading.append(createPresetIcon('default'));
  presetSelectControl.trigger.prepend(presetHeading);
  const widthSelectControl = createToolbarDropdown('preview-width-control', uiStrings.previewWidth);
  const widthControl = widthSelectControl.element;
  const widthSelect = widthSelectControl.select;
  const presetInfo = createPreviewPresetInfo();
  const presetInfoControl = presetInfo.element;
  // Keep the explanation next to its selector, including in overflow and split views.
  presetControl.append(presetInfoControl);
  const presetOptionInfos = new Map<PreviewPresetId, ReturnType<typeof createPreviewPresetInfo>>();
  presetSelectControl.setFooterAction(uiStrings.previewPresetManage, () => onManagePresets?.());
  for (const preset of previewPresets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name[uiLanguage];
    presetSelect.append(option);
  }
  for (const [value, label] of [['responsive', uiStrings.previewWidthResponsive], ['reference', uiStrings.previewWidthReference]]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    widthSelect.append(option);
  }
  const refreshPresetOptions = () => {
    for (const info of presetOptionInfos.values()) info.dispose();
    presetOptionInfos.clear();
    const selected = presetSelect.value;
    presetSelect.replaceChildren(...previewPresets.filter(preset => isPreviewPresetEnabled(preset.id)).map(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name[uiLanguage];
      return option;
    }));
    if (previewPresets.some(preset => preset.id === selected)) presetSelect.value = selected;
    presetSelectControl.refreshOptions();
    for (const option of presetSelectControl.panel.querySelectorAll<HTMLButtonElement>('[role="option"]')) {
      const preset = getPreviewPreset(option.dataset.value as PreviewPresetId);
      const name = document.createElement('span');
      name.className = 'preview-preset-option-name';
      name.textContent = preset.name[uiLanguage];
      option.setAttribute('aria-label', preset.name[uiLanguage]);
      option.setAttribute('aria-description', preset.description[uiLanguage]);
      option.replaceChildren(
        createPresetIcon(preset.id),
        name,
        createIconElement(Check, { width: 14, height: 14, class: 'preview-preset-option-check', 'aria-hidden': 'true' })
      );
      const info = createPreviewPresetInfo(option);
      info.present(preset, uiLanguage); presetOptionInfos.set(preset.id, info);
    }
    const footer = presetSelectControl.panel.querySelector<HTMLButtonElement>('.preview-dropdown-footer');
    if (footer) {
      const name = document.createElement('span'); name.className = 'preview-preset-option-name'; name.textContent = uiStrings.previewPresetManage;
      footer.replaceChildren(createIconElement(Plus, { width: 15, height: 15, 'aria-hidden': 'true' }), name);
    }
  };
  refreshPresetOptions();
  widthSelectControl.refreshOptions();
  const fontFamilySelect = fontFamilySelectControl.select;
  fontFamilySelect.classList.add('preview-font-family-select');
  const defaultFontOption = document.createElement('option');
  defaultFontOption.value = '';
  defaultFontOption.textContent = uiStrings.previewFontPlaceholder;
  fontFamilySelect.append(defaultFontOption);
  const defaultCodeFontOption = defaultFontOption.cloneNode(true) as HTMLOptionElement;
  codeFontFamilySelect.append(defaultCodeFontOption);
  let fontCatalog: readonly PreviewFont[] = fallbackPreviewFonts;
  let fontCatalogLoaded = false;
  let fontCatalogAvailable = false;
  let fontCatalogError = false;
  let fontLoad: Promise<void> | undefined;
  const fontPickers = [fontFamilySelectControl, codeFontFamilySelectControl];
  const updateFontPickerLabels = () => {
    for (const picker of fontPickers) {
      picker.setLabels({ search: uiStrings.previewFontSearch, clear: uiStrings.previewFontClearSearch, empty: uiStrings.previewFontEmpty, reset: uiStrings.previewFontReset, resetShort: uiStrings.previewFontResetShort, refresh: uiStrings.previewFontRefresh, refreshShort: uiStrings.previewFontRefreshShort, missing: uiStrings.previewFontMissing });
      picker.setStatus(fontLoad ? uiStrings.previewFontLoading : fontCatalogError ? uiStrings.previewFontUnavailable : '', Boolean(fontLoad));
    }
  };
  const rebuildFontOptions = () => {
    for (const [index, picker] of fontPickers.entries()) {
      const current = index === 0 ? fontFamilyPreference : codeFontFamilyPreference;
      const defaultOption = index === 0 ? defaultFontOption : defaultCodeFontOption;
      const options = fontCatalog.map(font => {
        const option = document.createElement('option'); option.value = font.family; option.textContent = font.localizedFamilies?.[uiLanguage] ?? font.family; option.dataset.aliases = [...font.aliases, ...Object.values(font.localizedFamilies ?? {})].join(' '); return option;
      });
      if (current && !options.some(option => option.value === current)) {
        const option = document.createElement('option'); option.value = current; option.textContent = current; if (fontCatalogAvailable && !fontCatalog.some(font => [font.family, ...font.aliases].some(name => name.toLocaleLowerCase() === current.toLocaleLowerCase()))) option.dataset.missing = 'true'; options.unshift(option);
      }
      picker.select.replaceChildren(defaultOption, ...options); picker.select.value = current; picker.refreshOptions();
    }
  };
  const loadFonts = (refresh: boolean): Promise<void> => {
    if (fontLoad) return fontLoad;
    if (fontCatalogLoaded && !refresh) return Promise.resolve();
    for (const picker of fontPickers) picker.setStatus(uiStrings.previewFontLoading, true);
    fontLoad = Promise.resolve().then(() => requestFonts?.(refresh) ?? null).catch(() => null).then(fonts => {
      if (disposed) return;
      fontCatalogLoaded = true;
      fontCatalogError = !fonts?.length;
      if (fonts?.length) { fontCatalog = fonts; fontCatalogAvailable = true; }
      for (const picker of fontPickers) picker.setStatus(fonts?.length ? '' : uiStrings.previewFontUnavailable);
      rebuildFontOptions();
    }).finally(() => { fontLoad = undefined; });
    return fontLoad;
  };
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
    presetSelectControl.setLabel(uiStrings.previewPreset);
    presetSelectControl.setFooterAction(uiStrings.previewPresetManage, () => onManagePresets?.());
    for (const option of presetSelect.options) option.textContent = getPreviewPreset(option.value as PreviewPresetId).name[language];
    refreshPresetOptions();
    widthSelectControl.setLabel(uiStrings.previewWidth);
    appearanceLabel.textContent = uiStrings.previewAppearance;
    appearanceSegments.element.setAttribute('aria-label', uiStrings.previewAppearance);
    appearanceSelect.options[0].textContent = uiStrings.auto;
    appearanceSelect.options[1].textContent = uiStrings.light;
    appearanceSelect.options[2].textContent = uiStrings.dark;
    appearanceSegments.setLabels({ auto: uiStrings.auto, light: uiStrings.light, dark: uiStrings.dark });
    sourceColoringLabel.textContent = uiStrings.previewCodeColors;
    sourceColoringSegments.element.setAttribute('aria-label', uiStrings.previewCodeColors);
    sourceColoringSelect.options[0].textContent = uiStrings.previewCodeColorsOn;
    sourceColoringSelect.options[1].textContent = uiStrings.previewCodeColorsOff;
    sourceColoringSegments.setLabels({ true: uiStrings.previewCodeColorsOn, false: uiStrings.previewCodeColorsOff });
    showCommentsLabel.textContent = uiStrings.showComments;
    showCommentsSegments.element.setAttribute('aria-label', uiStrings.showComments);
    showCommentsSegments.setLabels({ true: uiStrings.previewCommentsShow, false: uiStrings.previewCommentsHide });
    fontFamilySelectControl.setLabel(uiStrings.previewFontFamily);
    codeFontFamilySelectControl.setLabel(uiStrings.previewCodeFontFamily);
    updateFontPickerLabels();
    defaultFontOption.textContent = presetPreference === 'default' ? uiStrings.previewFontPlaceholder : uiStrings.previewPresetFont;
    fontFamilySelectControl.refreshOptions();
    updatePresetControls();
    alignPreviewButton.dataset.tooltip = uiStrings.alignPreviewToSource;
    alignPreviewButton.setAttribute('aria-label', uiStrings.alignPreviewToSource);
    alignSourceButton.dataset.tooltip = uiStrings.alignSourceToPreview;
    alignSourceButton.setAttribute('aria-label', uiStrings.alignSourceToPreview);
    scrollToTopController.setUiLanguage(language);
    if (frame.contentDocument) addPreviewCodeCopyControls(frame.contentDocument, language);
  };

  const scrollToTopController = createDocumentScrollToTopController(uiLanguage, () => {
    notifyViewportInteraction();
    return onNavigateToTop?.() ?? false;
  });
  host.append(frame, status, scrollToTopController.button);

  let appearancePreference: PreviewAppearance = 'auto';
  let appearance: 'light' | 'dark' = 'dark';
  let sourcePreviewControls = false;
  let synchronizedScrolling = true;
  let sourceColoring = true;
  let showComments = false;
  let fontFamilyPreference = '';
  let defaultFontFamilyPreference = '';
  let codeFontFamilyPreference = '';
  let defaultCodeFontFamilyPreference = '';
  let defaultAppearancePreference: PreviewAppearance = 'auto';
  let defaultSourceColoring = true;
  let defaultShowComments = false;
  let presetPreference: PreviewPresetId = 'default';
  let contentWidthPreference: PreviewContentWidth = 'responsive';
  let presetPreferences: PreviewPresetState['preferences'] = {};
  const currentPresetPreference = () => ({
    appearance: appearancePreference,
    contentWidth: contentWidthPreference,
    ...(getPreviewPreset(presetPreference).controls.fontFamily.mode === 'editable' ? { fontFamily: fontFamilyPreference, codeFontFamily: codeFontFamilyPreference } : {}),
    ...(getPreviewPreset(presetPreference).controls.codeColoring.mode === 'editable' ? { sourceColoring } : {}),
    ...(getPreviewPreset(presetPreference).controls.htmlComments.mode === 'editable' ? { showComments } : {})
  });
  const persistPresetPreference = (preference: PreviewPresetPreferencePatch) => {
    const initialPreference = currentPresetPreference();
    presetPreferences[presetPreference] = initialPreference;
    if (presetPreference !== 'default') vscode.postMessage({ type: 'setPreviewPresetPreference', preset: presetPreference, preference, initialPreference });
    onPresetPreferencesChanged?.();
  };
  let presetDiagnostics: readonly PreviewPresetDiagnostic[] = [];
  const presetRenderErrors = new Map<PreviewPresetId, string>();
  const presetCodeFallbacks = new Set<PreviewPresetId>();
  const updatePresetInfo = () => {
    for (const [id, info] of [[presetPreference, presetInfo], ...presetOptionInfos] as const) {
      const preset = getPreviewPreset(id);
      const errors = presetDiagnostics.filter(diagnostic => !diagnostic.preset || diagnostic.preset === preset.id || !previewPresets.some(item => item.id === diagnostic.preset)).map(diagnostic => diagnostic.message);
      const renderError = presetRenderErrors.get(preset.id);
      if (renderError) errors.push(renderError);
      if (presetCodeFallbacks.has(preset.id)) errors.push(uiStrings.previewCodeTypographyFallback);
      info.present(preset, uiLanguage, errors);
    }
  };
  const isSourceColoringEnabled = () => {
    const policy = getPreviewPreset(presetPreference).controls.codeColoring;
    return policy.mode === 'editable' ? sourceColoring : policy.mode === 'fixed' && policy.value === true;
  };
  const applyPreviewCodeTheme = (nextAppearance: 'light' | 'dark') => {
    const preset = getPreviewPreset(presetPreference);
    const theme = getPreviewPresetCodeTheme(preset, nextAppearance);
    if (theme) setShikiTheme(({ 'light-plus': lightPlusTheme, 'dark-plus': darkPlusTheme, 'github-light-default': githubLightTheme, 'github-dark-default': githubDarkTheme }[theme]) as RawVscodeTheme, 'preview');
    else applyCodeTheme(nextAppearance);
  };
  const updateBooleanPresetControls = () => {
    const preset = getPreviewPreset(presetPreference);
    for (const [key, control, segments, preference, onReason, offReason] of [
      ['codeColoring', sourceColoringControl, sourceColoringSegments, sourceColoring, uiStrings.previewFixedCodeColorsOn, uiStrings.previewFixedCodeColorsOff],
      ['htmlComments', showCommentsControl, showCommentsSegments, showComments, uiStrings.previewFixedCommentsShow, uiStrings.previewFixedCommentsHide]
    ] as const) {
      const policy = preset.controls[key];
      const fixed = policy.mode !== 'editable';
      const enabled = policy.mode === 'editable' ? preference : policy.mode === 'fixed' && policy.value === true;
      segments.setActive(String(enabled) as 'true' | 'false');
      const reason = policy.mode === 'unsupported' ? uiStrings.previewUnsupportedOption : fixed ? enabled ? onReason : offReason : '';
      control.dataset.tooltip = reason;
      control.dataset.tooltipPositioning = 'pointer';
      control.setAttribute('aria-description', reason);
      control.setAttribute('aria-disabled', String(fixed));
      for (const button of segments.element.querySelectorAll('button')) button.disabled = fixed;
      if (key === 'codeColoring') {
        sourceColoringSelect.value = String(enabled);
        sourceColoringSelect.disabled = fixed;
      }
    }
    updatePresetInfo();
  };
  const updateFontFamilyControl = () => {
    const policy = getPreviewPreset(presetPreference).controls.fontFamily;
    const fixed = policy.mode !== 'editable';
    defaultFontOption.textContent = policy.mode === 'fixed' ? uiStrings.previewControlStyles
      : policy.mode === 'unsupported' ? uiStrings.previewControlUnsupported
        : presetPreference === 'default' ? uiStrings.previewFontPlaceholder : uiStrings.previewPresetFont;
    defaultCodeFontOption.textContent = defaultFontOption.textContent;
    const reason = policy.mode === 'fixed' ? uiStrings.previewFixedFontFamily
      : policy.mode === 'unsupported' ? uiStrings.previewUnsupportedOption : '';
    for (const picker of fontPickers) {
      picker.select.disabled = fixed;
      picker.element.dataset.tooltip = reason; picker.element.dataset.tooltipPositioning = 'pointer';
      picker.element.setAttribute('aria-description', reason); picker.element.setAttribute('aria-disabled', String(fixed));
    }
    rebuildFontOptions();
    // Restored CSS family identifiers need the catalog's locale names before the picker opens.
    // Defer until initialization has applied the active preset, which may fix its fonts.
    if (uiLanguage === 'zh-CN' && !fontCatalogLoaded) queueMicrotask(() => {
      if (!disposed && uiLanguage === 'zh-CN' && (fontFamilyPreference || codeFontFamilyPreference)) void loadFonts(false);
    });
  };
  const updatePresetControls = () => {
    const preset = getPreviewPreset(presetPreference);
    presetHeading.firstElementChild?.replaceWith(createPresetIcon(preset.id));
    updateFontFamilyControl();
    updateBooleanPresetControls();
    presetSelect.value = presetPreference;
    presetSelectControl.syncFromSelect();
    presetSelectControl.trigger.setAttribute('aria-label', `${uiStrings.previewPreset}: ${preset.name[uiLanguage]}`);
    const appearances = preset.controls.appearance.options ?? [];
    const fixedAppearance = preset.controls.appearance.mode !== 'editable';
    const reason = preset.controls.appearance.mode === 'unsupported' ? uiStrings.previewUnsupportedOption
      : fixedAppearance ? getPresetInitialAppearance(preset) === 'light' ? uiStrings.previewOnlyLight
        : getPresetInitialAppearance(preset) === 'dark' ? uiStrings.previewOnlyDark : uiStrings.previewFixedAppearance : '';
    appearanceSegments.element.dataset.tooltip = reason;
    appearanceSegments.element.dataset.tooltipPositioning = 'pointer';
    appearanceSegments.element.setAttribute('aria-disabled', String(fixedAppearance));
    appearanceControl.setAttribute('aria-description', reason);
    appearanceSegments.element.setAttribute('aria-description', reason);
    appearanceSelect.disabled = fixedAppearance;
    for (const button of appearanceSegments.element.querySelectorAll<HTMLButtonElement>('[data-preview-appearance-choice]')) {
      button.hidden = fixedAppearance ? false : !appearances.includes(button.dataset.previewAppearanceChoice ?? '');
      button.disabled = fixedAppearance;
    }
    const widthPolicy = preset.controls.contentWidth;
    const fixedWidth = widthPolicy.mode !== 'editable';
    const widths = fixedWidth ? [preset.defaults.contentWidth] : widthPolicy.options ?? [];
    widthSelect.replaceChildren(...widths.map(width => {
      const option = document.createElement('option');
      option.value = width;
      option.textContent = widthPolicy.mode === 'unsupported' ? uiStrings.previewControlUnsupported
        : width === 'reference' ? uiStrings.previewWidthReference : uiStrings.previewWidthResponsive;
      return option;
    }));
    widthSelect.disabled = fixedWidth;
    widthSelect.value = fixedWidth ? preset.defaults.contentWidth : contentWidthPreference;
    const widthReason = widthPolicy.mode === 'fixed' ? uiStrings.previewFixedWidth
      : widthPolicy.mode === 'unsupported' ? uiStrings.previewUnsupportedOption : '';
    widthControl.dataset.tooltip = widthReason;
    widthControl.dataset.tooltipPositioning = 'pointer';
    widthControl.setAttribute('aria-description', widthReason);
    widthControl.setAttribute('aria-disabled', String(fixedWidth));
    widthSelectControl.refreshOptions();
    widthSelectControl.syncFromSelect();
    updatePresetInfo();
  };
  let requestGeneration = 0;
  let latestAcceptedRequestGeneration = -1;
  let frameGeneration = 0;
  let mermaidPresentationGeneration = 0;
  let activeFrameDocument: Document | null = null;
  let pendingPresentationScroll: { document: Document; scrollTop: number } | null = null;
  let appearanceRetention: { readonly retain: () => void; readonly release: () => void } | null = null;
  // Late diagram callbacks outlive the settling window and its shared reference.
  let appearanceRetentionGeneration = 0;
  let viewportInteractionGeneration = 0;
  let retainedViewportProjection: {
    readonly document: Document;
    readonly position: PreviewViewportPosition;
    readonly scrollTop: number;
    readonly interactionGeneration: number;
  } | null = null;
  let hasPendingRequest = false;
  let acceptingViewportProjection: PreviewViewportProjectionSlot | null = null;
  let pendingExternalViewportRestore: PendingExternalViewportRestore | null = null;
  let pendingText = '';
  let latestAcceptedText: string | null = null;
  let frameRenderedText: string | null = null;
  let loadingFrameText: string | null = null;
  type PreviewSourceMapEntry = {
    element: HTMLElement;
    start: number;
    end: number;
    top: number;
    bottom: number;
  };
  let sourceMapDocument: Document | null = null;
  let sourceMap: PreviewSourceMapEntry[] = [];
  let visualSourceMap: PreviewSourceMapEntry[] = [];
  let sourceMapByElement = new WeakMap<HTMLElement, PreviewSourceMapEntry>();
  let sourceMapDirty = true;
  let sourceMapResizeObserver: ResizeObserver | null = null;
  let sourceMapMeasureFrame: number | null = null;
  let sourcePositionMarker: HTMLElement | null = null;
  let sourcePositionMarkerDocument: Document | null = null;
  let sourcePositionMarkerState: PreviewSourcePositionMarkerState = {
    visible: false,
    line: 1,
    active: false
  };
  let latestPayload: PreviewRenderValue | null = null;
  const previewRenderTransport = createPreviewRenderTransport((message) => vscode.postMessage(message));
  const previewMermaidRenderer = createPreviewMermaidRenderer(
    mermaidRenderResources,
    (error) => logWebviewRenderError('preview.mermaid', error)
  );
  const notifyViewportInteraction = (owner: 'source' | 'preview' = 'preview') => {
    // Explicit navigation owns the new reading position even when its control
    // lives outside the iframe or uses Enter without a pointer gesture.
    viewportInteractionGeneration += 1;
    appearanceRetention?.release();
    retainedViewportProjection = null;
    pendingExternalViewportRestore = null;
    pendingPresentationScroll = null;
    onViewportInteraction?.(owner);
  };
  const search = createPreviewSearchController({
    getDocument: () => activeFrameDocument,
    isVisible: () => !host.hidden,
    onResultsChanged: () => onSearchResultsChanged?.(),
    onNavigate: notifyViewportInteraction,
    focus: () => {
      frame.focus();
      frame.contentWindow?.focus();
    }
  });
  let previewMathViewports = new Map<HTMLElement, {
    readonly controller: LatexMathViewportController;
    readonly signature: string;
  }>();
  let previewMathObserver: IntersectionObserver | null = null;
  let previewTableLayout: PreviewTableLayoutController | null = null;
  let disposeDeferredImages = () => {};
  let frameEvents: AbortController | null = null;
  let disposed = false;
  let paintFrame: number | null = null;
  let highlightFrame: number | null = null;
  let commitPendingCodeHighlight: (() => void) | null = null;
  const currentCodeHighlight = (frameDocument: Document): (() => boolean) => {
    const generation = frameGeneration;
    return () => !disposed && isSourceColoringEnabled() && (latestPayload?.preset ?? 'default') === presetPreference && generation === frameGeneration
      && activeFrameDocument === frameDocument;
  };
  const cancelHighlightFrame = () => {
    if (highlightFrame !== null) window.cancelAnimationFrame(highlightFrame);
    highlightFrame = null;
  };
  const scheduleViewportHighlight = (frameDocument: Document) => {
    if (highlightFrame !== null) return;
    highlightFrame = window.requestAnimationFrame(() => {
      highlightFrame = null;
      if (!disposed && activeFrameDocument === frameDocument && !host.hidden) {
        if (currentCodeHighlight(frameDocument)()) {
          applyPreviewCodeHighlight(frameDocument, true, currentCodeHighlight(frameDocument));
        }
        if (frameDocument.documentElement.dataset.meoPreviewLargeDocument === 'true' && latestPayload?.hasMermaid) {
          const generation = frameGeneration;
          void previewMermaidRenderer.render(frameDocument, appearance,
            () => { sourceMapDirty = true; },
            () => !disposed && !host.hidden && generation === frameGeneration && activeFrameDocument === frameDocument,
            mutate => withViewportTransaction(() => { mutate(); sourceMapDirty = true; }));
        }
      }
    });
  };
  const cancelPaintReady = () => {
    if (paintFrame !== null) window.cancelAnimationFrame(paintFrame);
    paintFrame = null;
  };
  const getCurrentPendingExternalViewportRestore = (): PreviewViewportRestore | null => {
    const pending = pendingExternalViewportRestore;
    if (!pending) return null;
    if (pending.requestGeneration !== requestGeneration || !pending.restore.isCurrent()) {
      pendingExternalViewportRestore = null;
      return null;
    }
    return pending.restore;
  };
  const schedulePaintReady = () => {
    cancelPaintReady();
    if (disposed || host.hidden) return;
    const stabilizePendingExternalViewport = () => {
      const restore = getCurrentPendingExternalViewportRestore();
      if (!restore) return;
      restoreTopLine(
        restore.line,
        restore.lineOffset,
        restore.viewportOffset,
        restore.sourceRange
      );
      retainViewportProjection(restore);
    };
    // A visible iframe can still have no compositor surface in this frame.
    // Keep the previous reading surface until the browser has painted it.
    paintFrame = window.requestAnimationFrame(() => {
      stabilizePendingExternalViewport();
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = null;
        if (!disposed && !host.hidden) {
          stabilizePendingExternalViewport();
          search.surfaceReady();
          onPaintReady?.();
          if (!hasPendingRequest) pendingExternalViewportRestore = null;
        }
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
    if (!disposed && isSourceColoringEnabled() && activeFrameDocument) {
      applyPreviewCodeHighlight(activeFrameDocument, true, currentCodeHighlight(activeFrameDocument));
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
      const restore = slot.restore;
      if (restore?.isCurrent()) {
        restoreTopLine(
          restore.line,
          restore.lineOffset,
          restore.viewportOffset,
          restore.sourceRange
        );
        retainViewportProjection(restore);
      }
      // A background resource commit belongs to the active appearance update.
      // Reaffirm that visual anchor before paint rather than adopting its
      // semantic projection as a new user scroll.
      appearanceRetention?.retain();
    } finally {
      acceptingViewportProjection = previousSlot;
    }
  };

  const disposePreviewMathViewports = () => {
    previewMathObserver?.disconnect();
    previewMathObserver = null;
    for (const viewport of previewMathViewports.values()) {
      viewport.controller.destroy();
    }
    previewMathViewports.clear();
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
    for (const source of frameDocument.querySelectorAll<HTMLSourceElement>('picture source[data-meo-deferred-image-srcset]')) {
      const rawSrc = source.getAttribute('data-meo-deferred-image-srcset') ?? '';
      source.removeAttribute('data-meo-deferred-image-srcset');
      source.dataset.meoPreviewImageSource = rawSrc;
      void resolveEmbeddedImageSrc(rawSrc, abortController.signal).then(resolved => {
        if (abortController.signal.aborted || disposed || activeFrameDocument !== frameDocument) return;
        enqueueCommit(() => {
          if (resolved) source.srcset = resolved;
          else source.removeAttribute('srcset');
        });
      });
    }
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
    previewMathObserver?.disconnect();
    previewMathObserver = null;
    const roots = Array.from(frameDocument.querySelectorAll<HTMLElement>(
      '.meo-export-math-display, .meo-export-math-inline'
    ));
    const currentRoots = new Set(roots);
    for (const [element, viewport] of previewMathViewports) {
      if (
        currentRoots.has(element)
        && element.isConnected
        && getPreviewPresentationSignature(element) === viewport.signature
      ) continue;
      viewport.controller.destroy();
      previewMathViewports.delete(element);
    }
    const attach = (element: HTMLElement) => {
      if (previewMathViewports.has(element)) {
        previewMathViewports.get(element)!.controller.setActive(true);
        return;
      }
      const copyActions = element.querySelector(':scope > .meo-preview-code-actions');
      copyActions?.remove();
      const controller = element.classList.contains('meo-export-math-inline')
        ? attachLatexMathViewport(element, { layout: { kind: 'inline' } })
        : attachLatexMathViewport(element)
      if (copyActions) element.append(copyActions);
      const signature = getPreviewPresentationSignature(element);
      if (signature) previewMathViewports.set(element, { controller, signature });
      else controller.destroy();
    };
    const frameWindow = frameDocument.defaultView;
    if (frameDocument.documentElement.dataset.meoPreviewLargeDocument === 'true' && frameWindow?.IntersectionObserver) {
      // A single observer gates the expensive per-formula resize/font measurements.
      // Keep fitted DOM when suspending so scrolling does not change page geometry.
      for (const viewport of previewMathViewports.values()) viewport.controller.setActive(false);
      previewMathObserver = new frameWindow.IntersectionObserver(entries => {
        if (disposed || activeFrameDocument !== frameDocument || host.hidden) return;
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          if (!element.isConnected) continue;
          if (entry.isIntersecting) attach(element);
          else previewMathViewports.get(element)?.controller.setActive(false);
        }
      }, { rootMargin: '800px 0px' });
      for (const element of roots) previewMathObserver.observe(element);
    } else {
      for (const element of roots) attach(element);
    }
  };

  const updateThemeToggle = () => {
    appearanceSelect.value = appearancePreference;
    const toolbarAppearance = sourcePreviewControls ? appearance : getEditorAppearance();
    if (optionsMenu) optionsMenu.style.colorScheme = toolbarAppearance;
    for (const control of [appearanceControl, sourceColoringControl, showCommentsControl]) {
      control.dataset.previewAppearance = toolbarAppearance;
    }
    fontFamilySelectControl.setAppearance(toolbarAppearance);
    codeFontFamilySelectControl.setAppearance(toolbarAppearance);
    presetSelectControl.setAppearance(toolbarAppearance);
    widthSelectControl.setAppearance(toolbarAppearance);
    for (const control of [fontFamilySelectControl, codeFontFamilySelectControl, presetSelectControl, widthSelectControl]) {
      control.panel.toggleAttribute('data-source-preview-theme', sourcePreviewControls);
      control.panel.style.colorScheme = toolbarAppearance;
    }
    appearanceSegments.setActive(appearancePreference);
    updatePresetInfo();
  };

  const syncDocumentBackground = (frameDocument: Document): void => {
    // Default follows the document carrier; independent presets and an opposite
    // preview appearance retain their own paired colors. No render is needed.
    frameDocument.documentElement.style.removeProperty('--meo-bg');
    for (const property of Object.keys(documentSurfaceVariables)) frameDocument.documentElement.style.removeProperty(property);
    if (presetPreference === 'default' && appearance === getEditorAppearance()) {
      frameDocument.documentElement.style.setProperty('--meo-bg', getComputedStyle(document.body).backgroundColor);
      const rootStyles = getComputedStyle(document.documentElement);
      for (const [property, role] of Object.entries(documentSurfaceVariables)) {
        frameDocument.documentElement.style.setProperty(property, rootStyles.getPropertyValue('--meo-document-' + role).trim());
      }
    }
    syncPreviewCopyPalette(frameDocument);
    const content = frameDocument.querySelector<HTMLElement>('.meo-export-doc');
    const frameWindow = frameDocument.defaultView;
    if (content && frameWindow) {
      const foreground = frameWindow.getComputedStyle(content).color;
      const background = frameWindow.getComputedStyle(frameDocument.body).backgroundColor;
      host.style.setProperty('--meo-preview-foreground', foreground);
      host.style.setProperty('--meo-preview-background', background);
      optionsMenu?.style.setProperty('--meo-preview-foreground', foreground);
      optionsMenu?.style.setProperty('--meo-preview-background', background);
      // Dropdowns are portaled to body, so they cannot inherit the Source preview palette.
      for (const control of [fontFamilySelectControl, codeFontFamilySelectControl, presetSelectControl, widthSelectControl]) {
        control.panel.style.setProperty('--meo-preview-foreground', foreground);
        control.panel.style.setProperty('--meo-preview-background', background);
      }
      // Source position and hover overlays share the resolved document palette, even with custom CSS.
      frameDocument.documentElement.style.setProperty('--meo-preview-foreground', foreground);
      frameDocument.documentElement.style.setProperty('--meo-preview-background', background);
      host.style.colorScheme = appearance;
      onPaletteChanged?.();
    }
  };

  const ensureReadableCode = (frameDocument: Document): void => {
    const frameWindow = frameDocument.defaultView;
    const content = frameDocument.querySelector<HTMLElement>('.meo-export-doc');
    if (!frameWindow || !content) return;
    const bodySize = Number.parseFloat(frameWindow.getComputedStyle(content).fontSize);
    let restored = false;
    for (const code of content.querySelectorAll<HTMLElement>('pre.meo-export-code-block code')) {
      const lines = code.querySelectorAll<HTMLElement>('.meo-export-code-line');
      for (const line of lines.length ? lines : [code]) {
        // Re-check the preset after theme updates instead of retaining a stale fallback.
        if (line.dataset.meoCodeTypographyFallback) {
          line.style.removeProperty('font-size');
          line.style.removeProperty('line-height');
          delete line.dataset.meoCodeTypographyFallback;
        }
        const styles = frameWindow.getComputedStyle(line);
        const size = Number.parseFloat(styles.fontSize);
        const height = Number.parseFloat(styles.lineHeight);
        if (!Number.isFinite(size) || size <= 0 || styles.lineHeight !== 'normal' && (!Number.isFinite(height) || height <= 0)) {
          line.style.setProperty('font-size', `${Math.max(8, (bodySize > 0 ? bodySize : 14) * 0.88)}px`, 'important');
          line.style.setProperty('line-height', '1.6', 'important');
          line.dataset.meoCodeTypographyFallback = 'true';
          restored = true;
        }
      }
    }
    if (restored) presetCodeFallbacks.add(presetPreference);
    else presetCodeFallbacks.delete(presetPreference);
    updatePresetInfo();
  };

  const syncPreviewCodeHighlight = (frameDocument: Document): void => {
    syncDocumentBackground(frameDocument);
    frameDocument.documentElement.dataset.meoPreviewSourceColoring = String(isSourceColoringEnabled());
    if (isSourceColoringEnabled()) applyPreviewCodeHighlight(frameDocument, true, currentCodeHighlight(frameDocument));
  };

  const syncPreviewCopyPalette = (frameDocument: Document): void => {
    const probe = document.createElement('span');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    for (const [property, variable, cssProperty] of [
      ['--meo-preview-code-copy-fg', '--meo-code-action-foreground', 'color'],
      ['--meo-preview-code-copy-hover-fg', '--meo-code-action-hover-foreground', 'color'],
      ['--meo-preview-code-copy-bg', '--meo-semantic-codeCopyBackground', 'backgroundColor'],
      ['--meo-preview-code-copy-hover-bg', '--meo-semantic-codeCopyHoverBackground', 'backgroundColor']
    ] as const) {
      // Independent preview palettes resolve their controls inside the iframe.
      if (presetPreference !== 'default' || appearance !== getEditorAppearance()) {
        frameDocument.documentElement.style.removeProperty(property);
        continue;
      }
      probe.style[cssProperty] = `var(${variable})`;
      document.body.appendChild(probe);
      frameDocument.documentElement.style.setProperty(property, window.getComputedStyle(probe)[cssProperty]);
      probe.remove();
    }
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

  const renderFrame = (
    renderedText: string,
    preserveViewport = false,
    pendingCodeBlocks?: readonly PreviewCodeBlockUpdate[]
  ) => {
    if (disposed || !latestPayload) {
      return;
    }
    appearanceRetention?.release();
    const payload = latestPayload;
    cancelHighlightFrame();
    commitPendingCodeHighlight = null;
    const reusableDocument = activeFrameDocument === frame.contentDocument ? activeFrameDocument : null;
    const reusableMain = reusableDocument?.querySelector<HTMLElement>('main.meo-export-doc');
    const previousRenderedText = frameRenderedText;
    frameEvents?.abort();
    frameEvents = null;
    search.invalidate();
    const loadGeneration = frameGeneration + 1;
    frameGeneration = loadGeneration;
    mermaidPresentationGeneration += 1;
    activeFrameDocument = null;
    retainedViewportProjection = null;
    pendingPresentationScroll = null;
    frameRenderedText = null;
    updateViewportAlignment();
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
      const mappedRoot = frameDocument?.querySelector<HTMLElement>('main.meo-export-doc');
      // The initial about:blank load can arrive before the srcdoc document.
      // Keep the presentation pending until its reading root exists.
      if (!frameDocument || !mappedRoot) {
        return;
      }
      activeFrameDocument = frameDocument;
      sourceMapDocument = null;
      sourceMap = [];
      visualSourceMap = [];
      sourceMapByElement = new WeakMap();
      sourceMapDirty = true;
      frameEvents = new AbortController();
      const signal = frameEvents.signal;
      frameRenderedText = renderedText;
      frameDocument.documentElement.dataset.meoPreviewLargeDocument = String(assessLargeDocument(renderedText).preferSource);
      loadingFrameText = null;
      sourceMapResizeObserver?.disconnect();
      const FrameResizeObserver = frame.contentWindow
        ? (frame.contentWindow as unknown as Pick<typeof globalThis, 'ResizeObserver'>).ResizeObserver
        : null;
      if (FrameResizeObserver && mappedRoot) {
        sourceMapResizeObserver = new FrameResizeObserver(() => {
          sourceMapDirty = true;
          if (sourceMapMeasureFrame !== null) return;
          sourceMapMeasureFrame = window.requestAnimationFrame(() => {
            sourceMapMeasureFrame = null;
            if (!disposed && activeFrameDocument === frameDocument) {
              getSourceMap();
              refreshSourcePositionMarker();
              onGeometryChanged?.();
            }
          });
        });
        sourceMapResizeObserver.observe(mappedRoot);
      }
      const styleElement = frameDocument.querySelector<HTMLStyleElement>('style[data-meo-preview-styles]');
      if (styleElement) styleElement.textContent = payload.styles[appearance];
      previewTableLayout?.dispose();
      frameDocument.documentElement.dataset.meoPreviewPreset = payload.preset ?? 'default';
      frameDocument.documentElement.dataset.meoPreviewPresetRevision = payload.presetRevision ?? '';
      if (!previewPresets.some(preset => preset.id === (payload.preset ?? 'default'))) return;
      const preset = getPreviewPreset(payload.preset);
      frameDocument.documentElement.dataset.meoPreviewRenderer = preset.renderer;
      syncGithubPictures(frameDocument, appearance);
      frameDocument.documentElement.dataset.meoPreviewBracketColoring = String(preset.id === 'default');
      previewTableLayout = preset.renderer === 'meo' ? createPreviewTableLayoutController(frameDocument) : null;
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
      addPreviewCodeCopyControls(frameDocument, uiLanguage);
      attachPreviewMathViewports(frameDocument);
      syncPreviewCodeHighlight(frameDocument);
      ensureReadableCode(frameDocument);
      frameDocument.addEventListener('scroll', () => {
        if (!disposed && activeFrameDocument === frameDocument) scheduleViewportHighlight(frameDocument);
        if (!disposed && activeFrameDocument === frameDocument) {
          onViewportChange?.();
        }
      }, { passive: true, signal });
      frameDocument.addEventListener('toggle', () => scheduleViewportHighlight(frameDocument), { capture: true, signal });
      const notifyTrustedViewportInteraction = (event: Event) => {
        if (!event.isTrusted) return;
        if (event.type === 'keydown') {
          const key = (event as KeyboardEvent).key;
          if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) return;
        }
        notifyViewportInteraction();
      };
      // Ownership follows gestures that can actually move the reading surface.
      // Selection/focus events may be browser-generated by a DOM replacement and
      // must never turn a presentation update into a reverse linked scroll.
      for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
        frameDocument.addEventListener(type, notifyTrustedViewportInteraction, { capture: true, signal });
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
      bindPreviewLinks(frameDocument, vscode, notifyViewportInteraction, signal);
      bindPreviewWheelFallback(frameDocument, signal);
      bindPreviewShortcuts(frame, onShortcut, signal);
      const keepPosition = () => {
        if (
          disposed ||
          !isCurrent()
        ) return;
        const viewportRestore = getCurrentPendingExternalViewportRestore() ?? viewportSlot?.restore;
        if (viewportRestore?.isCurrent()) {
          restoreTopLine(
            viewportRestore.line,
            viewportRestore.lineOffset,
            viewportRestore.viewportOffset,
            viewportRestore.sourceRange
          );
          retainViewportProjection(viewportRestore);
        }
      };
      const finishRender = () => {
        keepPosition();
        refreshSourcePositionMarker();
        updateViewportAlignment();
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
          // Source input may change before the debounced next preview request.
          () => isCurrent() && isCurrentText?.(renderedText) !== false,
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
        reusableDocument.documentElement.lang = uiLanguage;
        const deferredCodeBlocks = morphPreviewMain(
          reusableDocument,
          reusableMain,
          payload.html,
          isSourceColoringEnabled(),
          pendingCodeBlocks,
          () => !disposed && isSourceColoringEnabled() && loadGeneration === frameGeneration,
          (reusableDocument.documentElement.dataset.meoPreviewPreset ?? 'default') === (payload.preset ?? 'default')
        );
        if (deferredCodeBlocks.length > 0) {
          commitPendingCodeHighlight = () => {
            if (
              !disposed && activeFrameDocument === reusableDocument
              && latestPayload === payload && frameRenderedText === renderedText
            ) renderFrame(renderedText, true, deferredCodeBlocks);
          };
        }
        if (!preserveViewport && reusableDocument.scrollingElement) {
          reusableDocument.scrollingElement.scrollTop = 0;
        }
        initializeFrame(viewportSlot);
      };
      if (preserveViewport) {
        const wasAtDocumentTop = (reusableDocument.scrollingElement?.scrollTop ?? 0) <= 0.5;
        withViewportTransaction(
          (slot) => commit(slot),
          // Unchanged text is a layout update: preserve its semantic reading point,
          // rather than the pixel scroll offset used for edits inside the viewport.
          previousRenderedText === null || previousRenderedText === renderedText
            ? undefined
            : { previousText: previousRenderedText, nextText: renderedText }
        );
        // The first mapped source block can begin below the page padding.
        // Projecting line 1 to that block would scroll away the document top.
        if (wasAtDocumentTop && reusableDocument.scrollingElement) {
          reusableDocument.scrollingElement.scrollTop = 0;
          retainedViewportProjection = null;
        }
      }
      else commit(null);
      return;
    }
    disposePreviewMathViewports();
    previewTableLayout?.dispose();
    previewTableLayout = null;
    loadingFrameText = renderedText;
    frame.onload = () => initializeFrame();
    frame.srcdoc = `<!DOCTYPE html><html lang="${uiLanguage}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexStylesTag}<style data-meo-preview-styles>${styles}</style><style>${previewScrollbarStyles}${previewCodeCopyStyles}${previewLatexMathViewportStyles}${previewSourcePositionMarkerStyles}.meo-export-doc a[data-meo-preview-href]{cursor:pointer}${previewSearchStyles}</style></head><body><div class="meo-export-page"><main class="meo-export-doc markdown-body">${payload.html}</main></div></body></html>`;
  };

  const applyAppearanceToFrame = (preserveReadingPosition = false) => {
    if (disposed) return;
    appearanceRetention?.release();
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
    const readingPosition = preserveReadingPosition ? getTopVisiblePosition() : null;
    const wasAtDocumentTop = preserveReadingPosition && (scrollElement?.scrollTop ?? preservedScrollTop) <= 0.5;
    const viewportHeight = frame.clientHeight;
    const visualAnchor = preserveReadingPosition && !wasAtDocumentTop
      ? Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 40 && rect.top < viewportHeight;
      }) ?? null
      : null;
    const visualRect = visualAnchor?.getBoundingClientRect();
    const visualProgress = visualRect && visualRect.height >= viewportHeight
      ? Math.max(0, Math.min(1, (40 - visualRect.top) / visualRect.height)) : null;
    const visualY = visualRect && visualProgress !== null
      ? visualRect.top + visualRect.height * visualProgress : visualRect?.top;
    const interactionGeneration = viewportInteractionGeneration;
    const presentationGeneration = mermaidPresentationGeneration + 1;
    const renderedText = frameRenderedText;
    mermaidPresentationGeneration = presentationGeneration;
    const isCurrent = () => (
      !disposed &&
      presentationGeneration === mermaidPresentationGeneration &&
      activeFrameDocument === frameDocument &&
      frame.contentDocument === frameDocument
    );
    let retainedScrollTop = scrollElement?.scrollTop ?? 0;
    let hasRetainedPosition = false;
    const retentionGeneration = appearanceRetentionGeneration;
    let retentionCancelled = host.hidden;
    let layoutObserver: ResizeObserver | null = null;
    const keepPosition = (fromPresentation = false) => {
      // Let the appearance render finish, but retire its old reading offset as
      // soon as the user interacts with the frame during asynchronous work.
      if (isCurrent() && !retentionCancelled && retentionGeneration === appearanceRetentionGeneration
        && interactionGeneration === viewportInteractionGeneration && scrollElement) {
        const scrollDelta = scrollElement.scrollTop - retainedScrollTop;
        const visualDelta = visualAnchor?.isConnected && visualY !== undefined
          ? visualAnchor.getBoundingClientRect().top - (visualRect?.top ?? visualY) : null;
        if (!fromPresentation && hasRetainedPosition && Math.abs(scrollDelta) > 24 && (
          wasAtDocumentTop || (visualDelta !== null && Math.abs(visualDelta + scrollDelta) < 8)
        )) {
          retention.release();
          retainedViewportProjection = null;
          pendingPresentationScroll = null;
          return;
        }
        const recordRetainedPosition = () => {
          retainedScrollTop = scrollElement.scrollTop;
          hasRetainedPosition = true;
        };
        if (wasAtDocumentTop) {
          scrollElement.scrollTop = 0;
          retainedViewportProjection = null;
          recordRetainedPosition();
          return;
        }
        if (visualAnchor?.isConnected && visualY !== undefined) {
          const rect = visualAnchor.getBoundingClientRect();
          const currentY = visualProgress === null ? rect.top : rect.top + rect.height * visualProgress;
          scrollElement.scrollTop += currentY - visualY;
          retainedViewportProjection = null;
          recordRetainedPosition();
          return;
        }
        if (readingPosition) {
          sourceMapDirty = true;
          restoreTopLine(
            readingPosition.topLine,
            readingPosition.topLineOffset,
            readingPosition.viewportOffset,
            readingPosition.sourceRange
          );
          recordRetainedPosition();
          return;
        }
        if (Math.abs(scrollElement.scrollTop - preservedScrollTop) > 0.1) {
          scrollElement.scrollTop = preservedScrollTop;
        }
        recordRetainedPosition();
      }
    };
    const retention = {
      retain: () => keepPosition(true),
      release: (): void => {
        retentionCancelled = true;
        layoutObserver?.disconnect();
        if (appearanceRetention === retention) appearanceRetention = null;
      }
    };
    if (preserveReadingPosition && !retentionCancelled) appearanceRetention = retention;
    layoutObserver = preserveReadingPosition && !retentionCancelled && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => keepPosition()) : null;
    const previewContent = frameDocument.querySelector<HTMLElement>('.meo-export-doc');
    if (previewContent) layoutObserver?.observe(previewContent);
    if (visualAnchor && visualAnchor !== previewContent) layoutObserver?.observe(visualAnchor);
    // This is a presentation-only update of the same frame and document. A
    // cross-surface semantic projection would race this exact reading offset.
    styleElement.textContent = payload.styles[appearance];
    // A queued image commit can capture a reading anchor before ResizeObserver
    // reports this style change. Never let it project the previous geometry.
    sourceMapDirty = true;
    syncGithubPictures(frameDocument, appearance);
    frameDocument.documentElement.dataset.meoPreviewBracketColoring = String(presetPreference === 'default');
    previewTableLayout?.refresh();
    syncPreviewCodeHighlight(frameDocument);
    ensureReadableCode(frameDocument);
    keepPosition();
    if (preserveReadingPosition && !retentionCancelled) {
      let remainingFrames = 20;
      const settlePosition = () => {
        if (!isCurrent() || retentionCancelled || interactionGeneration !== viewportInteractionGeneration) {
          retention.release();
          return;
        }
        keepPosition();
        if (--remainingFrames > 0) requestAnimationFrame(settlePosition);
        else {
          layoutObserver?.disconnect();
          if (appearanceRetention === retention) appearanceRetention = null;
        }
      };
      requestAnimationFrame(settlePosition);
    } else {
      layoutObserver?.disconnect();
    }
    updateViewportAlignment();
    onRendered?.({ skipLinkedViewportProjection: true });
    if (payload.hasMermaid) {
      void previewMermaidRenderer.render(
        frameDocument,
        appearance,
        () => {
          sourceMapDirty = true;
          scrollToTopController.sync();
          keepPosition();
        },
        () => isCurrent() && (renderedText === null || isCurrentText?.(renderedText) !== false),
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
    if (post && (getPreviewPreset(presetPreference).controls.appearance.mode !== 'editable'
      || !getPreviewPreset(presetPreference).controls.appearance.options?.includes(nextAppearance))) return;
    if (nextAppearance !== 'auto' && nextAppearance !== 'light' && nextAppearance !== 'dark') {
      return;
    }
    nextAppearance = normalizePresetAppearance(getPreviewPreset(presetPreference), nextAppearance);
    const resolvedAppearance = resolvePresetAppearance(getPreviewPreset(presetPreference), nextAppearance, getEditorAppearance());
    const changed = appearance !== resolvedAppearance;
    if (changed) capturePresentationScroll();
    appearancePreference = nextAppearance;
    appearance = resolvedAppearance;
    if (presetPreference === 'default') defaultAppearancePreference = nextAppearance;
    applyPreviewCodeTheme(resolvedAppearance);
    updateThemeToggle();
    if (changed && activeFrameDocument) {
      applyAppearanceToFrame();
    }
    if (post) {
      if (presetPreference === 'default') vscode.postMessage({ type: 'setPreviewAppearance', appearance: appearancePreference });
      persistPresetPreference({ appearance: appearancePreference });
    }
  };

  const getStyleEnvironment = () => getExportStyleEnvironment({
    captureDocumentSurfaces: presetPreference === 'default' && appearance === getEditorAppearance(),
    previewFontFamily: fontFamilyPreference,
    previewCodeFontFamily: codeFontFamilyPreference,
    previewSourceColoring: sourceColoring,
    previewShowComments: showComments,
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
    // DOM readiness is not cache validity: an older iframe may finish loading
    // after a newer environment request fails. Only its accepted generation can
    // authorize reuse, both while srcdoc loads and after it becomes readable.
    const canReuseAcceptedPayload = !force && latestPayload !== null
      && latestAcceptedRequestGeneration === requestGeneration
      && text === latestAcceptedText;
    if (canReuseAcceptedPayload && text === loadingFrameText) return Promise.resolve();
    if (canReuseAcceptedPayload
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
    if (pendingExternalViewportRestore) {
      pendingExternalViewportRestore = pendingExternalViewportRestore.restore.isCurrent()
        ? { ...pendingExternalViewportRestore, requestGeneration: generation }
        : null;
    }
    hasPendingRequest = true;
    pendingText = text;
    updateViewportAlignment();
    setPendingStatus(background);
    return previewRenderTransport.render({
      text,
      uiLanguage,
      environment: getStyleEnvironment(),
      preset: presetPreference,
      ...(getPreviewPreset(presetPreference).custom ? { presetRevision: getPreviewPreset(presetPreference).custom!.revision } : {}),
      contentWidth: contentWidthPreference
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
        presetRenderErrors.set(presetPreference, result.error.message);
        updatePresetInfo();
        setStatus(uiStrings.previewFailed);
        schedulePaintReady();
        return;
      }
      latestAcceptedRequestGeneration = generation;
      presetRenderErrors.delete(presetPreference);
      updatePresetInfo();
      latestPayload = result.value;
      latestAcceptedText = requestText;
      setStatus(null);
      // An appearance-only refresh must not strand source still waiting on tokens.
      if (
        preserveFrame && activeFrameDocument && frameRenderedText === requestText
        && !commitPendingCodeHighlight
      ) {
        applyAppearanceToFrame(preserveViewport);
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
    // Host preload can retain CRLF while CodeMirror's Draft and later renders use LF.
    text = normalizeDocumentText(text);
    const preserveCurrentFrame = preserveFrame
      && activeFrameDocument !== null
      && frameRenderedText === text;
    if (preserveCurrentFrame) capturePresentationScroll();
    return performRequestRender(text, {
      background,
      force,
      preserveViewport,
      preserveFrame
    });
  };

  const acceptRenderResponse = (message: PreviewRenderResponse) => (
    disposed ? false : previewRenderTransport.accept(message)
  );

  const updateSourceColoringControl = (): void => {
    updateBooleanPresetControls();
  };

  const setSourceColoring = (
    enabled: boolean,
    { post = false }: { readonly post?: boolean } = {}
  ): void => {
    if (post && getPreviewPreset(presetPreference).controls.codeColoring.mode !== 'editable') return;
    if (!post || presetPreference === 'default') defaultSourceColoring = enabled;
    if (!post && presetPreference !== 'default') return;
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
    if (post) {
      if (presetPreference === 'default') vscode.postMessage({ type: 'setPreviewSourceColoring', enabled });
      persistPresetPreference({ sourceColoring: enabled });
    }
  };

  const setFontPreference = (value: string, post = false, code = false) => {
    if (post && getPreviewPreset(presetPreference).controls.fontFamily.mode !== 'editable') return;
    const normalized = normalizePreviewFontFamily(value);
    if (normalized === null) return;
    if (!post) {
      if (code) defaultCodeFontFamilyPreference = normalized; else defaultFontFamilyPreference = normalized;
      if (presetPreference !== 'default') return;
    }
    const changed = (code ? codeFontFamilyPreference : fontFamilyPreference) !== normalized;
    if (code) codeFontFamilyPreference = normalized; else fontFamilyPreference = normalized;
    updateFontFamilyControl();
    if (changed && (latestPayload || hasPendingRequest)) {
      const text = hasPendingRequest ? pendingText : latestAcceptedText;
      if (text !== null) void requestRender(text, { force: true, preserveViewport: true, preserveFrame: true });
    }
    if (changed && post) {
      if (presetPreference === 'default') {
        if (code) defaultCodeFontFamilyPreference = normalized; else defaultFontFamilyPreference = normalized;
        vscode.postMessage({ type: code ? 'setPreviewCodeFontFamily' : 'setPreviewFontFamily', fontFamily: normalized });
      }
      persistPresetPreference(code ? { codeFontFamily: normalized } : { fontFamily: normalized });
    }
  };
  const setFontFamily = (value: string, options: { readonly post?: boolean } = {}) => setFontPreference(value, options.post);
  const setCodeFontFamily = (value: string, options: { readonly post?: boolean } = {}) => setFontPreference(value, options.post, true);

  const handleAppearanceControlChange = () => {
    const nextAppearance = appearanceSelect.value;
    if (nextAppearance !== 'auto' && nextAppearance !== 'light' && nextAppearance !== 'dark') {
      return;
    }
    setAppearance(nextAppearance, { post: true });
  };
  appearanceSelect.addEventListener('change', handleAppearanceControlChange);
  const handleAppearanceSegmentClick = (event: MouseEvent) => {
    const value = (event.target as Element).closest<HTMLButtonElement>('[data-preview-appearance-choice]')?.dataset.previewAppearanceChoice;
    if (value === 'auto' || value === 'light' || value === 'dark') setAppearance(value, { post: true });
  };
  appearanceSegments.element.addEventListener('click', handleAppearanceSegmentClick);
  const handleSourceColoringChange = () => setSourceColoring(sourceColoringSelect.value === 'true', { post: true });
  sourceColoringSelect.addEventListener('change', handleSourceColoringChange);
  const handleSourceColoringSegmentClick = (event: MouseEvent) => {
    const value = (event.target as Element).closest<HTMLButtonElement>('[data-preview-source-coloring]')?.dataset.previewSourceColoring;
    if (value === 'true' || value === 'false') setSourceColoring(value === 'true', { post: true });
  };
  sourceColoringSegments.element.addEventListener('click', handleSourceColoringSegmentClick);
  const handleFontFamilyChange = () => setFontFamily(fontFamilySelect.value, { post: true });
  fontFamilySelect.addEventListener('change', handleFontFamilyChange);
  const handleCodeFontFamilyChange = () => setCodeFontFamily(codeFontFamilySelect.value, { post: true });
  codeFontFamilySelect.addEventListener('change', handleCodeFontFamilyChange);
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
      visualSourceMap = [...sourceMap]
        .sort((left, right) => left.top - right.top || left.bottom - right.bottom || left.start - right.start);
      sourceMapByElement = new WeakMap();
      for (const entry of sourceMap) sourceMapByElement.set(entry.element, entry);
    }
    return sourceMap;
  };

  const setShowComments = (enabled: boolean, { post = false }: { readonly post?: boolean } = {}): void => {
    if (post && getPreviewPreset(presetPreference).controls.htmlComments.mode !== 'editable') return;
    if (!post || presetPreference === 'default') defaultShowComments = enabled;
    if (!post && presetPreference !== 'default') return;
    const changed = showComments !== enabled;
    showComments = enabled;
    updateBooleanPresetControls();
    const text = hasPendingRequest ? pendingText : latestAcceptedText;
    if (changed && text !== null) requestRender(text, { force: true, preserveViewport: true });
    if (changed && post) {
      if (presetPreference === 'default') vscode.postMessage({ type: 'setPreviewShowComments', enabled });
      persistPresetPreference({ showComments: enabled });
    }
  };
  const handleShowCommentsSegmentClick = (event: MouseEvent) => {
    const value = (event.target as Element).closest<HTMLButtonElement>('[data-preview-comments]')?.dataset.previewComments;
    if (value === 'true' || value === 'false') setShowComments(value === 'true', { post: true });
  };
  showCommentsSegments.element.addEventListener('click', handleShowCommentsSegmentClick);
  setShowComments(false);
  const getPresetState = (): PreviewPresetState => ({
    preset: presetPreference,
    preferences: { ...presetPreferences, [presetPreference]: currentPresetPreference() }
  });
  const setPreset = (preset: PreviewPresetId, { persist = true, force = false, render = true } = {}) => {
    if (disposed || !previewPresets.some(item => item.id === preset) || !isPreviewPresetEnabled(preset) || preset === presetPreference && !force) return;
    if (previewPresets.some(item => item.id === presetPreference)) {
      presetPreferences[presetPreference] = currentPresetPreference();
    }
    capturePresentationScroll();
    presetPreference = preset;
    const definition = getPreviewPreset(preset);
    const preference = presetPreferences[preset] ?? { appearance: getPresetInitialAppearance(definition), contentWidth: definition.defaults.contentWidth };
    fontFamilyPreference = preset === 'default' ? defaultFontFamilyPreference
      : getPreviewPreset(preset).controls.fontFamily.mode === 'editable' ? presetPreferences[preset]?.fontFamily ?? '' : '';
    codeFontFamilyPreference = preset === 'default' ? defaultCodeFontFamilyPreference
      : getPreviewPreset(preset).controls.fontFamily.mode === 'editable' ? presetPreferences[preset]?.codeFontFamily ?? '' : '';
    updateFontFamilyControl();
    appearancePreference = normalizePresetAppearance(getPreviewPreset(preset), preference.appearance);
    contentWidthPreference = preference.contentWidth;
    sourceColoring = preset === 'default' ? defaultSourceColoring : preference.sourceColoring ?? defaultSourceColoring;
    showComments = preset === 'default' ? defaultShowComments : preference.showComments ?? defaultShowComments;
    appearance = resolvePresetAppearance(getPreviewPreset(preset), appearancePreference, getEditorAppearance());
    applyPreviewCodeTheme(appearance);
    updateThemeToggle();
    updatePresetControls();
    const text = hasPendingRequest ? pendingText : latestAcceptedText;
    if (render && text !== null) void requestRender(text, { force: true, preserveViewport: true });
    if (persist) {
      vscode.postMessage({ type: 'setPreviewPreset', preset });
      onPresetPreferencesChanged?.();
    }
  };
  const restorePresetState = (value: unknown) => {
    const state = decodePreviewPresetState(value);
    if (!state) return;
    presetPreferences = { ...state.preferences, default: { appearance: defaultAppearancePreference, contentWidth: 'responsive', fontFamily: defaultFontFamilyPreference, codeFontFamily: defaultCodeFontFamilyPreference, sourceColoring: defaultSourceColoring, showComments: defaultShowComments } };
    setPreset(state.preset, { persist: false });
  };
  const handlePresetChange = () => {
    if (isPreviewPresetId(presetSelect.value)) setPreset(presetSelect.value);
  };
  const updateCustomPresets = (presets: readonly PreviewPresetDefinition[], selected?: PreviewPresetId, initial = false, diagnostics: readonly PreviewPresetDiagnostic[] = [], { render = true, disabled = [] as readonly PreviewPresetId[] } = {}) => {
    presetDiagnostics = diagnostics;
    // Preserve the old font policy before its definition can be replaced or removed.
    if (!initial) presetPreferences[presetPreference] = currentPresetPreference();
    replaceCustomPreviewPresets(presets, disabled);
    refreshPresetOptions();
    if (initial) { updatePresetControls(); return; }
    const next = selected ?? (previewPresets.some(preset => preset.id === presetPreference) && isPreviewPresetEnabled(presetPreference) ? presetPreference : 'default');
    setPreset(next, { force: true, render });
  };
  const handleWidthChange = () => {
    const width = widthSelect.value;
    if (getPreviewPreset(presetPreference).controls.contentWidth.mode !== 'editable'
      || !getPreviewPreset(presetPreference).controls.contentWidth.options?.includes(width)
      || (width !== 'responsive' && width !== 'reference')) return;
    contentWidthPreference = width;
    const text = hasPendingRequest ? pendingText : latestAcceptedText;
    if (text !== null) void requestRender(text, { force: true, preserveViewport: true, preserveFrame: true });
    persistPresetPreference({ contentWidth: width });
  };
  presetSelect.addEventListener('change', handlePresetChange);
  widthSelect.addEventListener('change', handleWidthChange);
  updatePresetControls();
  updateFontPickerLabels();
  const getVisualSourceMap = (): PreviewSourceMapEntry[] => {
    getSourceMap();
    return visualSourceMap;
  };
  const findVisualRangeProjection = (
    sourceRange: NonNullable<PreviewViewportPosition['sourceRange']>,
    viewportAnchor: number
  ): PreviewSourceMapEntry | undefined => {
    const ranges = getVisualSourceMap().filter(entry => (
      entry.start === sourceRange.startLine && entry.end === sourceRange.endLine
    ));
    if (ranges.length === 0) return undefined;
    // Mirror getTopVisiblePosition: the visual entry whose top is the last one
    // at or above the reading band owns the anchor. Source order and nearest-top
    // selection are lossy when a rendered container and one of its descendants
    // intentionally expose the same source range.
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle].top <= viewportAnchor + 0.5) low = middle + 1;
      else high = middle - 1;
    }
    return ranges[Math.max(0, high)];
  };
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
  const getPreviewContentLeft = (frameDocument: Document, scrollElement: Element): number | null => {
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc');
    if (!readingRoot) return null;
    const rootRect = readingRoot.getBoundingClientRect();
    const rootStyle = frameDocument.defaultView?.getComputedStyle(readingRoot);
    const rootPaddingLeft = Number.parseFloat(rootStyle?.paddingLeft ?? '');
    return rootRect.left + scrollElement.scrollLeft
      + (Number.isFinite(rootPaddingLeft) ? rootPaddingLeft : 0);
  };
  const getSourcePositionMarker = (frameDocument: Document): HTMLElement => {
    if (sourcePositionMarkerDocument === frameDocument && sourcePositionMarker?.isConnected) {
      return sourcePositionMarker;
    }
    const marker = frameDocument.createElement('div');
    marker.className = 'meo-preview-source-position-marker';
    marker.hidden = true;
    marker.setAttribute('aria-hidden', 'true');
    const cursor = frameDocument.createElement('span');
    cursor.className = 'meo-preview-source-position-cursor';
    cursor.appendChild(frameDocument.importNode(createIconElement(TextCursor, {
      width: 16,
      height: 16,
      class: 'lucide lucide-text-cursor',
      'aria-hidden': 'true'
    }), true));
    const rail = frameDocument.createElement('span');
    rail.className = 'meo-preview-source-position-rail';
    marker.append(cursor, rail);
    (frameDocument.querySelector('main.meo-export-doc') ?? frameDocument.body).appendChild(marker);
    sourcePositionMarker = marker;
    sourcePositionMarkerDocument = frameDocument;
    return marker;
  };
  const projectSourcePositionMarker = (line: number): {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly lineHeight: number;
    readonly kind: 'line' | 'block';
  } | null => {
    const frameDocument = getFrameDocument();
    const scrollElement = frameDocument?.scrollingElement;
    if (!frameDocument || !scrollElement) return null;
    const source = findSourceProjection(line);
    const entry = source?.exact;
    if (!entry) return null;
    const contentLeft = getPreviewContentLeft(frameDocument, scrollElement);
    if (contentLeft === null) return null;
    const computedLineHeight = Number.parseFloat(
      frameDocument.defaultView?.getComputedStyle(entry.element).lineHeight ?? ''
    );
    const lineHeight = Number.isFinite(computedLineHeight)
      ? computedLineHeight
      : Math.max(1, entry.bottom - entry.top);
    return {
      top: entry.top,
      bottom: Math.max(entry.top + 1, entry.bottom),
      left: contentLeft,
      lineHeight,
      kind: entry.start === entry.end ? 'line' : 'block'
    };
  };
  const viewportAlignment = document.createElement('div');
  viewportAlignment.className = 'meo-preview-viewport-alignment';
  viewportAlignment.hidden = true;
  const createAlignmentButton = (owner: 'source' | 'preview'): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'format-button meo-preview-viewport-align-button';
    button.dataset.meoAlignViewport = owner === 'source' ? 'preview' : 'source';
    button.appendChild(createIconElement([
      ['path', { d: 'm10 8-4 4 4 4' }],
      ['path', { d: 'M6 12h12' }]
    ], { width: 22, height: 22, class: 'lucide lucide-arrow-left', 'aria-hidden': 'true' }));
    button.addEventListener('pointerdown', event => {
      // Pointer activation scrolls a view without stealing its focus or selection.
      if (event.button === 0) event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      updateViewportAlignment();
      if (button.disabled || viewportAlignment.hidden) return;
      notifyViewportInteraction(owner);
      onAlignViewport?.(owner);
    });
    return button;
  };
  const alignPreviewButton = createAlignmentButton('source');
  const alignSourceButton = createAlignmentButton('preview');
  viewportAlignment.append(alignPreviewButton, alignSourceButton);
  host.appendChild(viewportAlignment);
  const updateViewportAlignment = (): void => {
    viewportAlignment.hidden = disposed || host.hidden || !sourcePreviewControls || synchronizedScrolling;
    const ready = !viewportAlignment.hidden && frameRenderedText !== null && Boolean(getFrameDocument()?.scrollingElement)
      && isCurrentText?.(frameRenderedText) !== false && getSourceMap().length > 0;
    alignPreviewButton.disabled = alignSourceButton.disabled = !ready;
  };

  const refreshTheme = (): void => {
    const text = hasPendingRequest ? pendingText : latestAcceptedText;
    if (text === null) return;
    void requestRender(text, {
      force: true,
      preserveViewport: true,
      preserveFrame: true
    });
  };
  const refreshSourcePositionMarker = (revealIfOutside = false): boolean => {
    const frameDocument = getFrameDocument();
    const scrollElement = frameDocument?.scrollingElement;
    if (!frameDocument || !scrollElement) return false;
    const marker = getSourcePositionMarker(frameDocument);
    const projection = sourcePositionMarkerState.visible
      ? projectSourcePositionMarker(sourcePositionMarkerState.line)
      : null;
    marker.hidden = !projection;
    marker.classList.toggle('is-active', sourcePositionMarkerState.active);
    marker.dataset.meoSourcePositionLine = String(sourcePositionMarkerState.line);
    if (!projection) return false;
    marker.dataset.meoSourcePositionKind = projection.kind;

    const viewportHeight = scrollElement.clientHeight || frame.contentWindow?.innerHeight || 0;
    let revealed = false;
    if (revealIfOutside && viewportHeight > 0) {
      const viewportTop = scrollElement.scrollTop;
      const viewportBottom = viewportTop + viewportHeight;
      const above = projection.bottom <= viewportTop;
      const below = projection.top >= viewportBottom;
      if (above || below) {
        const context = projection.lineHeight;
        const requestedTop = above
          ? projection.top - context
          : projection.bottom + context - viewportHeight;
        const nextTop = Math.max(0, Math.min(
          requestedTop,
          scrollElement.scrollHeight - viewportHeight
        ));
        if (Math.abs(scrollElement.scrollTop - nextTop) > 0.5) {
          scrollElement.scrollTop = nextTop;
          revealed = true;
        }
      }
    }
    marker.style.left = '0px';
    marker.style.top = `${projection.top}px`;
    marker.style.height = `${projection.bottom - projection.top}px`;
    return revealed;
  };
  const restoreTopLine = (
    line: number,
    lineOffset = 0,
    viewportOffset = 0,
    sourceRange?: { startLine: number; endLine: number; progress: number }
  ): void => {
    retainedViewportProjection = null;
    const source = findSourceProjection(line);
    const scrollElement = getFrameDocument()?.scrollingElement;
    if (!scrollElement) {
      return;
    }
    if (sourceRange) {
      const range = findVisualRangeProjection(
        sourceRange,
        scrollElement.scrollTop + Math.max(0, viewportOffset)
      );
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
  const retainViewportProjection = (position: PreviewViewportPosition): void => {
    const frameDocument = getFrameDocument();
    const scrollElement = frameDocument?.scrollingElement;
    if (!frameDocument || !scrollElement) return;
    retainedViewportProjection = {
      document: frameDocument,
      position: {
        ...position,
        sourceRange: position.sourceRange ? { ...position.sourceRange } : undefined
      },
      scrollTop: scrollElement.scrollTop,
      interactionGeneration: viewportInteractionGeneration
    };
  };
  const getTopVisiblePosition = (viewportOffset = 0): {
    topLine: number;
    topLineOffset: number;
    editorLineOffset: number;
    viewportOffset: number;
    interpolatedWhitespace?: boolean;
    sourceRange?: { startLine: number; endLine: number; progress: number };
  } | null => {
    const frameDocument = getFrameDocument();
    const scrollElement = frameDocument?.scrollingElement;
    const boundedViewportOffset = Math.max(0, viewportOffset);
    const retained = retainedViewportProjection;
    if (
      retained && frameDocument && scrollElement &&
      retained.document === frameDocument &&
      retained.interactionGeneration === viewportInteractionGeneration &&
      Math.abs(scrollElement.scrollTop - retained.scrollTop) <= 0.5 &&
      Math.abs((retained.position.viewportOffset ?? 0) - boundedViewportOffset) <= 0.5
    ) {
      return {
        topLine: retained.position.line,
        topLineOffset: retained.position.lineOffset,
        editorLineOffset: 0,
        viewportOffset: boundedViewportOffset,
        sourceRange: retained.position.sourceRange ? { ...retained.position.sourceRange } : undefined
      };
    }
    if (retained) retainedViewportProjection = null;
    const entries = getVisualSourceMap();
    if (entries.length === 0) {
      return null;
    }
    const viewportTop = scrollElement?.scrollTop ?? 0;
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
        // A same-surface capture in whitespace must retain the visible gap.
        // Mode transitions sample a nonzero reading band and keep interpolation.
        if (boundedViewportOffset === 0) {
          return {
            topLine: next.start,
            topLineOffset: 0,
            editorLineOffset: 0,
            viewportOffset: next.top - viewportAnchor
          };
        }
        const gapHeight = Math.max(1, next.top - candidate.bottom);
        const ratio = Math.max(0, Math.min(1, (viewportAnchor - candidate.bottom) / gapHeight));
        return {
          topLine: Math.round(range.end + (next.start - range.end) * ratio),
          topLineOffset: 0,
          editorLineOffset: 0,
          viewportOffset: boundedViewportOffset,
          interpolatedWhitespace: true
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
    position: PreviewViewportPosition,
    isCurrent: () => boolean
  ): void => {
    const restore = { ...position, isCurrent };
    if (acceptingViewportProjection) {
      acceptingViewportProjection.restore = restore;
      return;
    }
    const hasUsableFrame = frameRenderedText !== null && getSourceMap().length > 0;
    pendingExternalViewportRestore = hasPendingRequest || !hasUsableFrame
      ? { restore, requestGeneration }
      : null;
    if (!hasUsableFrame) return;
    if (restore.isCurrent()) {
      restoreTopLine(
        restore.line,
        restore.lineOffset,
        restore.viewportOffset,
        restore.sourceRange
      );
      retainViewportProjection(restore);
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
    const viewportHeight = frame.contentWindow?.innerHeight ?? host.clientHeight;
    const elements = getSourceElements();
    const visibleLines = elements
      .filter((element) => {
        if (element.getClientRects().length === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight;
      })
      .map((element) => Number.parseInt(element.dataset.sourceLine ?? '1', 10))
      .filter(Number.isFinite);
    const fromLine = visibleLines.length > 0 ? Math.min(...visibleLines) : 1;
    // A hidden/unpainted surface has no visible range, never the entire document.
    const toLine = visibleLines.length > 0 ? Math.max(...visibleLines) : fromLine;
    return { from: fromLine, to: toLine, fromLine, toLine };
  };

  const outlineAdapter = {
    getHeadings,
    getViewportAnchorOffset: (ratio = 0.2) => {
      const anchorY = (frame.contentWindow?.innerHeight ?? host.clientHeight) * ratio;
      let activeLine = 1;
      for (const heading of getSourceElements()) {
        if (heading.getClientRects().length === 0) continue;
        if (heading.getBoundingClientRect().top > anchorY) {
          break;
        }
        activeLine = Number.parseInt(heading.dataset.sourceLine ?? '1', 10);
      }
      return activeLine;
    },
    getVisibleDocumentRange,
    getScrollElement: () => getFrameDocument() ?? frame,
    preserveViewportLayout: (mutate: () => void) => {
      const position = getTopVisiblePosition();
      mutate();
      if (!position) return;
      restoreTopVisiblePosition({
        line: position.topLine,
        lineOffset: position.topLineOffset,
        viewportOffset: position.viewportOffset,
        sourceRange: position.sourceRange
      }, () => true);
    },
    scrollToLine: (line: number) => {
      const target = getFrameDocument()?.querySelector<HTMLElement>(`[data-source-line="${line}"]`);
      if (!target) return;
      notifyViewportInteraction();
      target.scrollIntoView({ block: 'start' });
    }
  };

  return {
    host,
    presetControl,
    widthControl,
    presetInfoControl,
    getPresetState,
    setPreset,
    restorePresetState,
    updateCustomPresets,
    getPresetDiagnostics: () => presetDiagnostics,
    invalidateRender: () => { requestGeneration += 1; cancelPaintReady(); },
    getPresetRevision: () => getPreviewPreset(presetPreference).custom?.revision,
    appearanceControl,
    fontFamilyControl,
    codeFontFamilyControl,
    fontSearchInputs: fontPickers.map(picker => picker.searchInput),
    sourceColoringControl,
    showCommentsControl,
    closeToolbarDropdowns: () => {
      presetSelectControl.close();
      fontFamilySelectControl.close();
      codeFontFamilySelectControl.close();
      widthSelectControl.close();
    },
    requestRender,
    preload: (text: string) => requestRender(text, { background: true }),
    acceptRenderResponse,
    setAppearance: (nextAppearance: PreviewAppearance, options?: { readonly post?: boolean }) => {
      if (!options?.post && presetPreference !== 'default') {
        defaultAppearancePreference = nextAppearance;
        presetPreferences.default = { ...presetPreferences.default, appearance: nextAppearance, contentWidth: 'responsive' };
        return;
      }
      setAppearance(nextAppearance, options);
    },
    setSourceColoring,
    setShowComments,
    setFontFamily,
    setCodeFontFamily,
    setUiLanguage: applyUiLanguage,
    setSourcePositionMarker: (
      state: PreviewSourcePositionMarkerState,
      {
        revealIfOutside = false,
        deferLayout = false
      }: { readonly revealIfOutside?: boolean; readonly deferLayout?: boolean } = {}
    ) => {
      sourcePositionMarkerState = {
        visible: state.visible,
        line: Math.max(1, Math.round(state.line)),
        active: state.active
      };
      updateViewportAlignment();
      if (deferLayout) {
        if (!sourcePositionMarkerState.visible) {
          if (sourcePositionMarker) sourcePositionMarker.hidden = true;
        }
        return false;
      }
      return refreshSourcePositionMarker(revealIfOutside);
    },
    syncAutoAppearance: () => {
      if (appearancePreference === 'auto') setAppearance('auto');
      else {
        applyPreviewCodeTheme(appearance);
        updateThemeToggle();
      }
      refreshTheme();
    },
    refreshTheme,
    setSourcePreviewControls: (active: boolean, scrollSyncEnabled = true) => {
      sourcePreviewControls = active;
      synchronizedScrolling = scrollSyncEnabled;
      updateViewportAlignment();
      updateThemeToggle();
    },
    refreshDocumentBackground: (refreshMermaid = false) => {
      const frameDocument = getFrameDocument();
      if (!frameDocument) return;
      syncDocumentBackground(frameDocument);
      if (refreshMermaid && presetPreference === 'default' && appearance === getEditorAppearance()) {
        for (const block of frameDocument.querySelectorAll<HTMLElement>('.meo-export-mermaid[data-source-b64]')) delete block.dataset.meoPreviewMermaidAppearance;
        void previewMermaidRenderer.render(frameDocument, appearance, () => { sourceMapDirty = true; },
          () => !disposed && getFrameDocument() === frameDocument,
          mutate => withViewportTransaction(mutate));
      }
    },
    getAppearance: () => appearance,
    getSourceColoring: isSourceColoringEnabled,
    getStyleEnvironment: () => ({ ...getStyleEnvironment(), previewFontFamily: defaultFontFamilyPreference, previewCodeFontFamily: defaultCodeFontFamilyPreference }),
    getPresetFontFamily: () => presetPreference !== 'default' && getPreviewPreset(presetPreference).controls.fontFamily.mode === 'editable' ? fontFamilyPreference : undefined,
    getPresetCodeFontFamily: () => presetPreference !== 'default' && getPreviewPreset(presetPreference).controls.fontFamily.mode === 'editable' ? codeFontFamilyPreference : undefined,
    setVisible: (visible: boolean) => {
      host.hidden = !visible;
      host.inert = !visible;
      updateViewportAlignment();
      if (!visible) {
        previewMathObserver?.disconnect();
        previewMathObserver = null;
        for (const viewport of previewMathViewports.values()) viewport.controller.setActive(false);
        appearanceRetentionGeneration += 1;
        appearanceRetention?.release();
        cancelPaintReady();
        search.surfaceHidden();
      }
      else if (activeFrameDocument && !hasPendingRequest) {
        attachPreviewMathViewports(activeFrameDocument);
        scheduleViewportHighlight(activeFrameDocument);
        schedulePaintReady();
      }
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
      search.refreshLayout();
      sourceMapDirty = true;
      refreshSourcePositionMarker();
    },
    getSelectedText: () => frame.contentWindow?.getSelection()?.toString() ?? '',
    getSearchAdapter: () => search.adapter,
    getOutlineAdapter: () => outlineAdapter,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      appearanceRetention?.release();
      cancelPaintReady();
      cancelHighlightFrame();
      requestGeneration += 1;
      frameGeneration += 1;
      mermaidPresentationGeneration += 1;
      previewMermaidRenderer.dispose();
      unsubscribePreviewCodeHighlight();
      releasePreviewCodeHighlighting();
      activeFrameDocument = null;
      retainedViewportProjection = null;
      pendingExternalViewportRestore = null;
      commitPendingCodeHighlight = null;
      sourceMapDocument = null;
      sourceMap = [];
      visualSourceMap = [];
      sourceMapByElement = new WeakMap();
      sourceMapDirty = true;
      sourceMapResizeObserver?.disconnect();
      sourceMapResizeObserver = null;
      if (sourceMapMeasureFrame !== null) window.cancelAnimationFrame(sourceMapMeasureFrame);
      sourceMapMeasureFrame = null;
      sourcePositionMarker?.remove();
      sourcePositionMarker = null;
      sourcePositionMarkerDocument = null;
      viewportAlignment.remove();
      frameRenderedText = null;
      loadingFrameText = null;
      frame.style.removeProperty('visibility');
      hasPendingRequest = false;
      previewRenderTransport.cancelAll('Preview closed');
      presetInfo.dispose();
      for (const info of presetOptionInfos.values()) info.dispose();
      presetOptionInfos.clear();
      appearanceSelect.removeEventListener('change', handleAppearanceControlChange);
      sourceColoringSelect.removeEventListener('change', handleSourceColoringChange);
      appearanceSegments.element.removeEventListener('click', handleAppearanceSegmentClick);
      sourceColoringSegments.element.removeEventListener('click', handleSourceColoringSegmentClick);
      showCommentsSegments.element.removeEventListener('click', handleShowCommentsSegmentClick);
      fontFamilySelect.removeEventListener('change', handleFontFamilyChange);
      fontFamilySelectControl.dispose();
      codeFontFamilySelect.removeEventListener('change', handleCodeFontFamilyChange);
      codeFontFamilySelectControl.dispose();
      presetSelect.removeEventListener('change', handlePresetChange);
      widthSelect.removeEventListener('change', handleWidthChange);
      presetSelectControl.dispose();
      widthSelectControl.dispose();
      frame.onload = null;
      disposePreviewMathViewports();
      previewTableLayout?.dispose();
      previewTableLayout = null;
      frameEvents?.abort();
      frameEvents = null;
      disposeDeferredImages();
      scrollToTopController.setScrollElement(null);
      search.dispose();
    }
  };
}

function syncGithubPictures(frameDocument: Document, appearance: 'light' | 'dark'): void {
  if (frameDocument.documentElement.dataset.meoPreviewRenderer !== 'github-readme') return;
  for (const source of frameDocument.querySelectorAll<HTMLSourceElement>('picture source[media]')) {
    const media = source.dataset.meoGithubPictureMedia ?? source.media;
    source.dataset.meoGithubPictureMedia = media;
    source.media = githubPictureMedia(media, appearance);
  }
}

function bindPreviewLinks(
  frameDocument: Document,
  vscode: { postMessage: (message: WebviewMessage) => void },
  onNavigate: () => void,
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
      const github = frameDocument.documentElement.dataset.meoPreviewRenderer === 'github-readme';
      const destination = frameDocument.getElementById(fragmentId) ?? (github
        ? frameDocument.getElementById(`user-content-${fragmentId}`)
          ?? frameDocument.getElementsByName(fragmentId)[0]
          ?? frameDocument.getElementsByName(`user-content-${fragmentId}`)[0]
        : null);
      if (destination) {
        onNavigate();
        destination.scrollIntoView({ block: 'start' });
      }
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

function bindPreviewShortcuts(
  frame: HTMLIFrameElement,
  onShortcut: PreviewControllerOptions['onShortcut'],
  signal: AbortSignal
): void {
  const frameWindow = frame.contentWindow;
  if (!frameWindow) return;
  const forwardedKeys = new Set<string>();
  const forward = (event: KeyboardEvent): void => {
    // VS Code listens on the outer webview window, not inside nested iframes.
    // Its existing keyboard bridge retains user bindings and chord contexts.
    const forwarded = new KeyboardEvent(event.type, {
      key: event.key, code: event.code, keyCode: event.keyCode, location: event.location,
      ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
      shiftKey: event.shiftKey, repeat: event.repeat, bubbles: true, cancelable: true
    });
    frame.dispatchEvent(forwarded);
    if (forwarded.defaultPrevented) event.preventDefault();
    event.stopPropagation();
  };
  frameWindow.addEventListener('keydown', event => {
    if (onShortcut?.(event) || !isPreviewHostShortcut(event)) return;
    forwardedKeys.add(event.code || event.key);
    forward(event);
  }, { capture: true, signal });
  frameWindow.addEventListener('keyup', event => {
    if (event.isTrusted && forwardedKeys.delete(event.code || event.key)) forward(event);
  }, { capture: true, signal });
  frameWindow.addEventListener('blur', () => forwardedKeys.clear(), { signal });
}

function isPreviewHostShortcut(event: KeyboardEvent): boolean {
  if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.getModifierState('AltGraph')) return false;
  if (['Control', 'Meta', 'Alt', 'Shift', 'Process', 'Dead', 'Unidentified'].includes(event.key)) return false;
  // Reading selection and embedded inputs must retain native editing gestures.
  if (!event.altKey) {
    const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    const input = (event.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && ((!event.shiftKey && ['a', 'c', 'x', 'v', 'y', 'z'].includes(key))
      || (event.shiftKey && key === 'z') || (input && ['c', 'x', 'v'].includes(key)) || event.key === 'Insert')) return false;
    if (/^(Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Backspace|Delete)$/.test(event.key)) return false;
    if (event.shiftKey && event.key === 'Insert') return false;
  }
  return event.ctrlKey || event.metaKey || event.altKey || /^F(?:[1-9]|1\d|2[0-4])$/.test(event.key);
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
