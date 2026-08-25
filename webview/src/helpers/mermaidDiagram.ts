import { WidgetType, type EditorView } from '@codemirror/view';
import { createElement, ZoomIn, ZoomOut, RotateCcw, Maximize2, X } from 'lucide';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNodeRef } from '@lezer/common';
import type { MermaidConfig } from 'mermaid';
import { getViewportController } from './viewportController';
import { applyLiveBlockIndent } from './blockIndent';
import type { MermaidDiagramRenderRequest } from '../application/mermaidDiagramRenderResources';
import type {
  MermaidDiagramPresentationConsumer,
  MermaidDiagramPresentationHandle
} from '../editor/mermaidDiagramPresentation';

declare global {
  interface Window {
    mermaid?: MermaidRuntime;
  }
  var mermaid: MermaidRuntime | undefined;
}

type MermaidRuntimeConfig = MermaidConfig & {
  forceLegacyMathML?: boolean;
};

interface MermaidRuntime {
  initialize(config: MermaidRuntimeConfig): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

type MermaidSvgBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type MermaidFullscreenExitCause =
  | 'user-close'
  | 'escape'
  | 'dispose'
  | 'replacement'
  | 'mode'
  | 'external'
  | 'theme';

type MermaidFullscreenSession = {
  readonly overlay: HTMLElement;
  readonly container: HTMLElement;
  readonly svgWrapper: HTMLElement;
  readonly embedded: {
    readonly wrapper: HTMLElement;
    readonly transform: string;
    readonly zoom: number;
    readonly panX: number;
    readonly panY: number;
    readonly scroller: HTMLElement | null;
    readonly scrollTop: number | null;
    readonly focus: HTMLElement | null;
    readonly presentation: MermaidDiagramPresentationHandle | null;
  };
  zoom: number;
  panX: number;
  panY: number;
  baseScale: number;
  pointerId: number | null;
  cleanup: () => void;
  keydown: (event: KeyboardEvent) => void;
};

export const MERMAID_EDITOR_CONFIG_KEY = 'editor-v1';
const MERMAID_MATH_CLASS = 'meoMath';
const MERMAID_LABEL_WRAP_THEME_CSS =
  '.nodeLabel p{white-space:normal!important;overflow-wrap:anywhere!important;word-break:break-word!important;}';
const MERMAID_DIAGRAM_START_RE =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|c4Context|xychart(?:-beta)?|sankey-beta|block-beta|packet-beta|radar-beta)\b/i;
const MERMAID_DISPLAY_MATH_RE = /^\$\$[\s\S]*\$\$$/;
const DISPLAY_MATH_VIEWBOX_PADDING = Object.freeze({
  left: 22,
  top: 20,
  right: 12,
  bottom: 12
});
const DISPLAY_MATH_TRIM_RETRY_DELAYS_MS = Object.freeze([80, 220]);
const DISPLAY_MATH_LABEL_SELECTORS = Object.freeze([
  '.nodeLabel .katex-mathml math',
  '.nodeLabel .katex-html',
  '.nodeLabel .katex-display',
  '.nodeLabel'
]);
const DISPLAY_MATH_LABEL_SELECTOR = DISPLAY_MATH_LABEL_SELECTORS.join(', ');
const MERMAID_DISPLAY_MATH_THEME_CSS =
  '.nodeLabel > div{line-height:1 !important;margin:0 !important;padding:0 !important;}' +
  '.nodeLabel foreignObject{overflow:visible !important;}' +
  '.katex-display{margin:0 !important;}' +
  '.katex{line-height:1 !important;}';

function mermaidLayoutSignature(content: HTMLElement): string {
  const style = getComputedStyle(content);
  return `${content.clientWidth}|${style.fontSize}|${style.lineHeight}|${globalThis.devicePixelRatio ?? 1}`;
}

function mermaidPreviewHeightKey(
  diagramText: string,
  themeSignature: string,
  startLine: number,
  layoutSignature: string
): string {
  return `${startLine}\n${themeSignature}\n${layoutSignature}\n${diagramText}`;
}

export function getCachedMermaidPreviewHeight(
  factory: MermaidDiagramPresentationConsumer,
  view: EditorView,
  diagramText: string,
  startLine: number
): number | null {
  const key = mermaidPreviewHeightKey(
    diagramText,
    getMermaidThemeConfig().signature,
    startLine,
    mermaidLayoutSignature(view.contentDOM)
  );
  return factory.getHeight(`preview:${key}`);
}

function resolveCssColor(value: string, fallback: string, property: 'color' | 'backgroundColor' = 'backgroundColor'): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style[property] = trimmed;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe)[property];
  probe.remove();
  return resolved || fallback;
}

function clampColorChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampAlpha(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseCssNumericChannel(value: string, scale: number): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') {
    return null;
  }
  if (trimmed.endsWith('%')) {
    const percent = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * scale : null;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCssAlpha(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  const parsed = parseCssNumericChannel(value, 1);
  return parsed === null ? 1 : clampAlpha(parsed);
}

function formatMermaidRgb(red: number, green: number, blue: number, alpha = 1): string {
  const r = clampColorChannel(red);
  const g = clampColorChannel(green);
  const b = clampColorChannel(blue);
  const a = clampAlpha(alpha);
  if (a < 1) {
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

function normalizeRgbColor(value: string): string | null {
  const match = /^rgba?\(\s*(.+?)\s*\)$/i.exec(value);
  if (!match?.[1]) {
    return null;
  }
  const [rawChannels, rawAlpha] = match[1].split('/').map((part) => part.trim());
  const channels = rawChannels.split(/[\s,]+/).filter(Boolean);
  if (channels.length < 3) {
    return null;
  }
  const [red, green, blue] = channels.slice(0, 3).map((channel) => parseCssNumericChannel(channel, 255));
  if (red === null || green === null || blue === null) {
    return null;
  }
  const alpha = rawAlpha ? parseCssAlpha(rawAlpha) : parseCssAlpha(channels[3]);
  return formatMermaidRgb(red, green, blue, alpha);
}

function normalizeSrgbColor(value: string): string | null {
  const match = /^color\(\s*srgb\s+(.+?)\s*\)$/i.exec(value);
  if (!match?.[1]) {
    return null;
  }
  const [rawChannels, rawAlpha] = match[1].split('/').map((part) => part.trim());
  const channels = rawChannels.split(/\s+/).filter(Boolean);
  if (channels.length < 3) {
    return null;
  }
  const [red, green, blue] = channels.slice(0, 3).map((channel) => parseCssNumericChannel(channel, 1));
  if (red === null || green === null || blue === null) {
    return null;
  }
  const alpha = parseCssAlpha(rawAlpha);
  return formatMermaidRgb(red * 255, green * 255, blue * 255, alpha);
}

function normalizeMermaidFallbackColor(fallback: string): string {
  const trimmed = fallback.trim();
  if (!trimmed) {
    return '#ffffff';
  }
  return normalizeRgbColor(trimmed) ?? normalizeSrgbColor(trimmed) ?? (/^color\(/i.test(trimmed) ? '#ffffff' : trimmed);
}

function normalizeMermaidColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return normalizeMermaidFallbackColor(fallback);
  }
  const normalized = normalizeRgbColor(trimmed) ?? normalizeSrgbColor(trimmed);
  if (normalized) {
    return normalized;
  }
  if (/^(?:rgba?|color)\(/i.test(trimmed)) {
    return normalizeMermaidFallbackColor(fallback);
  }
  return trimmed;
}

function getThemeCssColor(
  name: string,
  fallback: string,
  property: 'color' | 'backgroundColor' = 'backgroundColor'
): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) {
    return normalizeMermaidColor(fallback, '#ffffff');
  }
  return normalizeMermaidColor(resolveCssColor(value, fallback, property), fallback);
}

function isProbablyDarkColor(color: string): boolean {
  const match = /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(color);
  if (!match) {
    return false;
  }
  const red = Number(match[1]);
  const green = Number(match[2]);
  const blue = Number(match[3]);
  if (![red, green, blue].every(Number.isFinite)) {
    return false;
  }
  return (red * 0.299 + green * 0.587 + blue * 0.114) < 128;
}

function isMermaidDarkTheme(background: string): boolean {
  return isProbablyDarkColor(background);
}

function getMermaidThemeConfig(): { signature: string; config: MermaidRuntimeConfig } {
  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const fontFamily = rootStyles.getPropertyValue('--meo-font-live').trim() || bodyStyles.fontFamily;
  const background = getThemeCssColor('--meo-code-background', bodyStyles.backgroundColor || '#ffffff');
  const darkMode = isMermaidDarkTheme(background);
  const nodeBackground = darkMode
    ? getThemeCssColor('--meo-surface-background', '#2f343d')
    : '#ffffff';
  const foreground = darkMode
    ? getThemeCssColor('--meo-foreground', '#c9d1d9', 'color')
    : '#1f2328';
  const border = darkMode
    ? getThemeCssColor('--meo-foreground', '#c9d1d9', 'color')
    : '#6e7781';
  const accent = getThemeCssColor('--meo-color-base05', border, 'color');
  const signature = [
    background,
    nodeBackground,
    foreground,
    border,
    accent,
    fontFamily,
    darkMode ? 'dark' : 'light'
  ].join('|');

  return {
    signature,
    config: {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily,
      themeVariables: {
        background,
        mainBkg: nodeBackground,
        secondBkg: nodeBackground,
        tertiaryColor: nodeBackground,
        primaryColor: nodeBackground,
        primaryTextColor: foreground,
        primaryBorderColor: border,
        nodeBorder: border,
        lineColor: border,
        textColor: foreground,
        nodeTextColor: foreground,
        edgeLabelBackground: background,
        clusterBkg: background,
        clusterBorder: border,
        titleColor: foreground,
        fontFamily,
        darkMode
      },
      htmlLabels: true,
      markdownAutoWrap: true,
      themeCSS: MERMAID_LABEL_WRAP_THEME_CSS,
      flowchart: {
        htmlLabels: true,
        wrappingWidth: 200
      },
      // VS Code webviews can vary in MathML support, so force KaTeX-backed output.
      legacyMathML: true,
      forceLegacyMathML: true
    }
  };
}

function isCurrentMermaidLightTheme(): boolean {
  const { config } = getMermaidThemeConfig();
  return config?.themeVariables?.darkMode !== true;
}

function applyMermaidThemeClass(element: HTMLElement): void {
  const lightTheme = isCurrentMermaidLightTheme();
  element.classList.toggle('meo-mermaid-light-theme', lightTheme);
  element.classList.toggle('meo-mermaid-dark-theme', !lightTheme);
}

function getMermaidRuntime() {
  const runtime = globalThis.mermaid ?? window.mermaid;
  if (!runtime || typeof runtime.render !== 'function') {
    return null;
  }
  return runtime;
}

export function loadMermaidRuntime() {
  const existing = getMermaidRuntime();
  if (existing) {
    return Promise.resolve(existing);
  }

  return Promise.reject(new Error('Preloaded Mermaid runtime unavailable'));
}

export function getMermaidEditorPresentationIdentity(): {
  readonly themeKey: string;
  readonly configKey: string;
} {
  return {
    themeKey: getMermaidThemeConfig().signature,
    configKey: MERMAID_EDITOR_CONFIG_KEY
  };
}

export async function initializeMermaidEditorRuntime(
  _themeKey: string,
  configKey: string
): Promise<void> {
  const runtime = await loadMermaidRuntime();
  const { config } = getMermaidThemeConfig();
  if (configKey !== MERMAID_EDITOR_CONFIG_KEY) throw new Error('Unsupported Mermaid editor config');
  runtime.initialize(config);
}

export async function renderMermaidRuntime(renderId: string, source: string): Promise<string> {
  await document.fonts?.ready;
  const runtime = await loadMermaidRuntime();
  const result = await runtime.render(renderId, source);
  return result.svg;
}

export async function restoreMermaidEditorTheme(): Promise<void> {
  const runtime = await loadMermaidRuntime();
  const { config } = getMermaidThemeConfig();
  runtime.initialize(config);
}

function mermaidRenderRequest(
  diagramText: string,
  themeSignature: string
): MermaidDiagramRenderRequest {
  return {
    rawSource: diagramText,
    normalizedSource: normalizeMermaidDiagramText(diagramText),
    themeKey: themeSignature,
    configKey: MERMAID_EDITOR_CONFIG_KEY
  };
}

function currentMermaidContentWidth(element?: HTMLElement): number {
  const ownContent = element?.closest<HTMLElement>('.cm-content');
  if (ownContent && ownContent.clientWidth > 0) return ownContent.clientWidth;
  return Array.from(
    document.querySelectorAll<HTMLElement>('.editor-host > .cm-editor .cm-content')
  ).find((content) => content.clientWidth > 0)?.clientWidth ?? 0;
}

function mermaidEstimatedHeightKey(resultCacheKey: string, contentWidth: number): string {
  return `estimated:${resultCacheKey}\nwidth:${Math.max(0, Math.round(contentWidth))}`;
}

function estimateCachedMermaidHeight(svgContent: string | undefined, contentWidth: number): number {
  if (!svgContent) return -1;
  const svgTag = svgContent.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  const width = Number(svgTag.match(/\bwidth=["']([\d.]+)(?:px)?["']/i)?.[1]);
  const height = Number(svgTag.match(/\bheight=["']([\d.]+)(?:px)?["']/i)?.[1]);
  const viewBox = svgTag.match(/\bviewBox=["'][\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)[ ,]+([\d.]+)["']/i);
  const intrinsicWidth = width > 0 ? width : Number(viewBox?.[1]);
  const intrinsicHeight = height > 0 ? height : Number(viewBox?.[2]);
  if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return -1;
  const availableWidth = Math.max(0, contentWidth - 24);
  const scale = availableWidth > 0 ? Math.min(1, availableWidth / intrinsicWidth) : 1;
  return intrinsicHeight * scale + 24;
}

export function isDisplayMathDiagram(diagramText: string): boolean {
  return MERMAID_DISPLAY_MATH_RE.test(diagramText.trim());
}

function compactDisplayMath(diagramText: string): string {
  const inner = diagramText.trim().slice(2, -2).trim();
  const singleLine = inner
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return `$$${singleLine}$$`;
}

function escapeForMermaidLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function normalizeMermaidDiagramText(diagramText: string): string {
  const trimmed = diagramText.trim();
  if (!trimmed || MERMAID_DIAGRAM_START_RE.test(trimmed)) {
    return diagramText;
  }
  if (!isDisplayMathDiagram(trimmed)) {
    return diagramText;
  }

  const escapedMath = escapeForMermaidLabel(compactDisplayMath(trimmed));
  const initConfig = JSON.stringify({
    flowchart: { diagramPadding: 0 },
    themeCSS: MERMAID_DISPLAY_MATH_THEME_CSS
  });

  return [
    `%%{init: ${initConfig}}%%`,
    'flowchart LR',
    `  MATH["${escapedMath}"]`,
    '  style MATH fill:transparent,stroke:transparent,stroke-width:0px',
    `  classDef ${MERMAID_MATH_CLASS} font-size:22px,padding:0px;`,
    `  class MATH ${MERMAID_MATH_CLASS}`
  ].join('\n');
}

export function getFencedCodeContent(state: EditorState, node: SyntaxNodeRef): string {
  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(Math.max(node.to - 1, node.from));
  const lastChild = node.node.lastChild;
  const hasClosingFence = lastChild?.name === 'CodeMark' &&
    state.doc.lineAt(lastChild.from).number === endLine.number;
  const lastContentLine = endLine.number - (hasClosingFence ? 1 : 0);
  const codeTextRanges: Array<{ from: number; to: number }> = [];

  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeText') {
      codeTextRanges.push({ from: child.from, to: child.to });
    }
  }

  const lines: string[] = [];
  for (let lineNumber = startLine.number + 1; lineNumber <= lastContentLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const parts = codeTextRanges
      .filter((range) => range.from <= line.to && range.to >= line.from)
      .map((range) => state.doc.sliceString(
        Math.max(range.from, line.from),
        Math.min(range.to, line.to)
      ));
    lines.push(parts.join(''));
  }

  return lines.join('\n');
}

export class MermaidDiagramWidget extends WidgetType {
  diagramText: string;
  startLine: number;
  endLine: number;
  isDisplayMath: boolean;
  zoom: number;
  panX: number;
  panY: number;
  fullscreenSession: MermaidFullscreenSession | null;
  themeSignature: string;
  cachePreviewHeight: boolean;
  previewResizeObserver: ResizeObserver | null;
  measuredHeight: number;
  indentColumns: number;
  presentationFactory: MermaidDiagramPresentationConsumer;
  presentationHandle: MermaidDiagramPresentationHandle | null;

  constructor(
    diagramText: string,
    startLine: number = 0,
    endLine: number = 0,
    options: {
      presentationFactory: MermaidDiagramPresentationConsumer;
      cachePreviewHeight?: boolean;
      indentColumns?: number;
    }
  ) {
    super();
    this.diagramText = diagramText;
    this.startLine = startLine;
    this.endLine = endLine;
    this.isDisplayMath = isDisplayMathDiagram(diagramText);
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.fullscreenSession = null;
    this.themeSignature = getMermaidEditorPresentationIdentity().themeKey;
    this.presentationFactory = options.presentationFactory;
    this.presentationHandle = null;
    this.cachePreviewHeight = options.cachePreviewHeight ?? true;
    this.indentColumns = options.indentColumns ?? 0;
    this.previewResizeObserver = null;
    const request = mermaidRenderRequest(this.diagramText, this.themeSignature);
    const cached = this.presentationFactory.getCached(request);
    const contentWidth = currentMermaidContentWidth();
    this.measuredHeight = this.presentationFactory.getHeight(
      mermaidEstimatedHeightKey(JSON.stringify(request), contentWidth)
    ) ?? estimateCachedMermaidHeight(cached && 'svg' in cached ? cached.svg : undefined, contentWidth);
  }

  get estimatedHeight(): number {
    return this.measuredHeight;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidDiagramWidget &&
      other.diagramText === this.diagramText &&
      other.startLine === this.startLine &&
      other.endLine === this.endLine &&
      other.indentColumns === this.indentColumns &&
      other.themeSignature === this.themeSignature
    );
  }

  toDOM(view?: EditorView) {
    const container = document.createElement('div');
    container.className = 'meo-mermaid-block';
    if (this.measuredHeight > 0) {
      container.style.minHeight = `${this.measuredHeight}px`;
    }
    container.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button === 0) {
        event.preventDefault();
      }
    });
    applyLiveBlockIndent(container, this.indentColumns);
    applyMermaidThemeClass(container);
    if (this.startLine > 0) {
      container.dataset.meoRenderedBlockStartLine = String(this.startLine);
    }
    if (this.endLine > 0) {
      container.dataset.meoRenderedBlockEndLine = String(this.endLine);
    }
    container.dataset.meoRenderedBlockKind = 'mermaid';
    if (this.isDisplayMath) {
      container.classList.add('meo-mermaid-math-block');
    }
    if (this.cachePreviewHeight && view && typeof ResizeObserver !== 'undefined') {
      this.previewResizeObserver = new ResizeObserver(() => {
        const height = container.getBoundingClientRect().height;
        if (height > 0 && container.querySelector('.meo-mermaid-svg-wrapper')) {
          const content = container.closest<HTMLElement>('.cm-content') ?? view.contentDOM;
          const cacheKey = mermaidPreviewHeightKey(
            this.diagramText,
            this.themeSignature,
            this.startLine,
            mermaidLayoutSignature(content)
          );
          this.measuredHeight = height;
          this.presentationFactory.rememberHeight(
            mermaidEstimatedHeightKey(
              JSON.stringify(mermaidRenderRequest(this.diagramText, this.themeSignature)),
              currentMermaidContentWidth(container)
            ),
            height
          );
          this.presentationFactory.rememberHeight(`preview:${cacheKey}`, height);
        }
      });
      this.previewResizeObserver.observe(container);
    }

    this.presentationHandle = this.presentationFactory.create({
      showPending: () => {
        const loading = document.createElement('div');
        loading.className = 'meo-mermaid-loading';
        loading.textContent = 'Loading...';
        container.replaceChildren(loading);
      },
      showDiagram: (svg) => {
        const estimatedHeight = estimateCachedMermaidHeight(svg, currentMermaidContentWidth(container));
        if (estimatedHeight > 0) {
          this.measuredHeight = estimatedHeight;
          this.presentationFactory.rememberHeight(
            mermaidEstimatedHeightKey(
              JSON.stringify(mermaidRenderRequest(this.diagramText, this.themeSignature)),
              currentMermaidContentWidth(container)
            ),
            estimatedHeight
          );
        }
        container.style.removeProperty('min-height');
        container.replaceChildren();
        this.renderSvg(container, svg);
      },
      showError: (_source, error) => {
        container.style.removeProperty('min-height');
        container.replaceChildren();
        this.renderError(container, error);
      },
      clearPresentation: () => {
        this.exitFullscreen('external');
        container.style.removeProperty('min-height');
        container.replaceChildren();
      },
      preserveLayoutChange: (apply) => {
        if (!view || !container.isConnected) {
          apply();
          return;
        }
        const controller = getViewportController(view);
        if (!controller || this.startLine <= 0 || this.endLine <= 0) {
          apply();
          view.requestMeasure();
          return;
        }
        const startLine = view.state.doc.line(Math.min(this.startLine, view.state.doc.lines));
        const endLine = view.state.doc.line(Math.min(this.endLine, view.state.doc.lines));
        controller.preserveLayoutChange({
          element: container,
          from: startLine.from,
          to: endLine.to
        }, apply);
      }
    });
    const identity = getMermaidEditorPresentationIdentity();
    this.presentationHandle.present(this.diagramText, identity.themeKey, identity.configKey);

    return container;
  }

  renderSvg(container: HTMLElement, svgContent: string): void {
    const svgWrapper = document.createElement('div');
    svgWrapper.className = 'meo-mermaid-svg-wrapper';
    svgWrapper.innerHTML = svgContent;

    container.appendChild(svgWrapper);
    if (this.isDisplayMath) {
      this.trimDisplayMathSvg(svgWrapper);
      return;
    }

    const controls = this.createZoomControls(svgWrapper);
    container.appendChild(controls);

  }

  trimDisplayMathSvg(svgWrapper: HTMLElement): void {
    let originalViewBox: MermaidSvgBox | null = null;

    const applyTrim = () => {
      const svg = svgWrapper.querySelector('svg');
      if (!(svg instanceof SVGSVGElement)) {
        return;
      }

      const bbox = this.getDisplayMathContentBox(svg) ?? this.getSvgContentBox(svg);
      if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
        return;
      }

      let x = bbox.x - DISPLAY_MATH_VIEWBOX_PADDING.left;
      let y = bbox.y - DISPLAY_MATH_VIEWBOX_PADDING.top;
      let width = bbox.width + DISPLAY_MATH_VIEWBOX_PADDING.left + DISPLAY_MATH_VIEWBOX_PADDING.right;
      let height = bbox.height + DISPLAY_MATH_VIEWBOX_PADDING.top + DISPLAY_MATH_VIEWBOX_PADDING.bottom;

      if (!originalViewBox) {
        originalViewBox = this.getSvgViewBox(svg);
      }
      if (originalViewBox) {
        if (x > originalViewBox.x) {
          width += x - originalViewBox.x;
          x = originalViewBox.x;
        }
        if (y > originalViewBox.y) {
          height += y - originalViewBox.y;
          y = originalViewBox.y;
        }
      }

      svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
      svg.setAttribute('width', `${width}`);
      svg.setAttribute('height', `${height}`);
    };

    requestAnimationFrame(applyTrim);
    for (const delay of DISPLAY_MATH_TRIM_RETRY_DELAYS_MS) {
      setTimeout(applyTrim, delay);
    }
  }

  getDisplayMathContentBox(svg: SVGSVGElement): MermaidSvgBox | null {
    const screenCtm = svg.getScreenCTM();
    if (!screenCtm) {
      return null;
    }

    let inverse;
    try {
      inverse = screenCtm.inverse();
    } catch {
      return null;
    }

    const labelNodes = svg.querySelectorAll<Element>(DISPLAY_MATH_LABEL_SELECTOR);
    const points: DOMPoint[] = [];
    for (const node of labelNodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      points.push(
        this.transformClientPointToSvg(svg, inverse, rect.left, rect.top),
        this.transformClientPointToSvg(svg, inverse, rect.right, rect.top),
        this.transformClientPointToSvg(svg, inverse, rect.right, rect.bottom),
        this.transformClientPointToSvg(svg, inverse, rect.left, rect.bottom)
      );
    }
    if (!points.length) {
      return null;
    }

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  transformClientPointToSvg(
    svg: SVGSVGElement,
    inverseCtm: DOMMatrix,
    x: number,
    y: number
  ): DOMPoint {
    if (typeof DOMPoint === 'function') {
      return new DOMPoint(x, y).matrixTransform(inverseCtm);
    }
    const point = svg.createSVGPoint();
    point.x = x;
    point.y = y;
    return point.matrixTransform(inverseCtm);
  }

  getSvgContentBox(svg: SVGSVGElement): DOMRect | null {
    if (typeof svg.getBBox !== 'function') {
      return null;
    }
    try {
      const contentNode = svg.querySelector<SVGGraphicsElement>('.nodes') ?? svg;
      return contentNode.getBBox();
    } catch {
      return null;
    }
  }

  getSvgViewBox(svg: SVGSVGElement): MermaidSvgBox | null {
    const rawViewBox = svg.getAttribute('viewBox');
    if (rawViewBox) {
      const parts = rawViewBox
        .trim()
        .split(/[\s,]+/)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        return {
          x: parts[0],
          y: parts[1],
          width: parts[2],
          height: parts[3]
        };
      }
    }

    const width = this.parseSvgLength(svg.getAttribute('width'));
    const height = this.parseSvgLength(svg.getAttribute('height'));
    if (width !== null && height !== null && width > 0 && height > 0) {
      return {
        x: 0,
        y: 0,
        width,
        height
      };
    }

    return null;
  }

  parseSvgLength(value: string | null): number | null {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  createZoomControls(svgContainer: HTMLElement): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'meo-visual-controls meo-mermaid-zoom-controls';
    applyMermaidThemeClass(controls);

    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    zoomIn.appendChild(createElement(ZoomIn, { width: 16, height: 16 }));
    zoomIn.setAttribute('aria-label', 'Zoom in');

    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    zoomOut.appendChild(createElement(ZoomOut, { width: 16, height: 16 }));
    zoomOut.setAttribute('aria-label', 'Zoom out');

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    reset.appendChild(createElement(RotateCcw, { width: 16, height: 16 }));
    reset.setAttribute('aria-label', 'Reset zoom');

    const fullscreen = document.createElement('button');
    fullscreen.type = 'button';
    fullscreen.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    fullscreen.appendChild(createElement(Maximize2, { width: 16, height: 16 }));
    fullscreen.setAttribute('aria-label', 'Fullscreen');

    zoomIn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setZoom(svgContainer, Math.min(4, this.zoom + 0.5));
    });

    zoomOut.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setZoom(svgContainer, Math.max(0.25, this.zoom - 0.5));
    });

    reset.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.applyTransform(svgContainer);
    });

    fullscreen.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFullscreen(svgContainer);
    });

    controls.appendChild(zoomIn);
    controls.appendChild(zoomOut);
    controls.appendChild(reset);
    controls.appendChild(fullscreen);

    return controls;
  }

  toggleFullscreen(svgContainer: HTMLElement): void {
    if (this.fullscreenSession) {
      this.exitFullscreen('user-close');
    } else {
      this.enterFullscreen(svgContainer);
    }
  }

  enterFullscreen(svgContainer: HTMLElement): void {
    if (this.fullscreenSession) {
      return;
    }
    const svgContent = svgContainer.innerHTML;

    const overlay = document.createElement('div');
    overlay.className = 'meo-mermaid-fullscreen-scrim';

    const fullscreenContainer = document.createElement('div');
    fullscreenContainer.className = 'meo-mermaid-fullscreen';
    applyMermaidThemeClass(fullscreenContainer);

    const svgWrapper = document.createElement('div');
    svgWrapper.className = 'meo-mermaid-svg-wrapper';
    svgWrapper.innerHTML = svgContent;

    const scroller = svgContainer.closest<HTMLElement>('.cm-scroller');
    const session: MermaidFullscreenSession = {
      overlay,
      container: fullscreenContainer,
      svgWrapper,
      embedded: {
        wrapper: svgContainer,
        transform: svgContainer.style.transform,
        zoom: this.zoom,
        panX: this.panX,
        panY: this.panY,
        scroller,
        scrollTop: scroller?.scrollTop ?? null,
        focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        presentation: this.presentationHandle
      },
      zoom: 1,
      panX: 0,
      panY: 0,
      baseScale: 1,
      pointerId: null,
      cleanup: () => {},
      keydown: () => {}
    };
    this.fullscreenSession = session;

    fullscreenContainer.appendChild(svgWrapper);

    const controls = this.createFullscreenControls(session);
    fullscreenContainer.appendChild(controls);

    this.attachFullscreenInteractions(session);

    overlay.appendChild(fullscreenContainer);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      if (this.fullscreenSession !== session) return;
      const svg = svgWrapper.querySelector('svg');
      if (svg) {
        const containerRect = fullscreenContainer.getBoundingClientRect();
        const padding = 80;
        const availableWidth = containerRect.width - padding;
        const availableHeight = containerRect.height - padding;

        const svgWidth = svg.getBoundingClientRect().width || svg.viewBox.baseVal.width;
        const svgHeight = svg.getBoundingClientRect().height || svg.viewBox.baseVal.height;

        if (svgWidth > 0 && svgHeight > 0) {
          const scaleX = availableWidth / svgWidth;
          const scaleY = availableHeight / svgHeight;
          session.baseScale = Math.min(scaleX, scaleY);
        } else {
          session.baseScale = 1;
        }

        this.applyFullscreenTransform(session);
      }
    });

    session.keydown = (event) => {
      if (event.key === 'Escape') {
        this.exitFullscreen('escape', session);
      }
    };
    document.addEventListener('keydown', session.keydown);
  }

  createFullscreenControls(session: MermaidFullscreenSession): HTMLElement {
    const svgContainer = session.svgWrapper;
    const controls = document.createElement('div');
    controls.className = 'meo-visual-controls meo-mermaid-zoom-controls meo-mermaid-fullscreen-controls';
    applyMermaidThemeClass(controls);

    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    zoomIn.appendChild(createElement(ZoomIn, { width: 16, height: 16 }));
    zoomIn.setAttribute('aria-label', 'Zoom in');

    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    zoomOut.appendChild(createElement(ZoomOut, { width: 16, height: 16 }));
    zoomOut.setAttribute('aria-label', 'Zoom out');

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'meo-visual-control-btn meo-mermaid-zoom-btn';
    reset.appendChild(createElement(RotateCcw, { width: 16, height: 16 }));
    reset.setAttribute('aria-label', 'Reset zoom');

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'meo-visual-control-btn meo-mermaid-zoom-btn meo-mermaid-exit-btn';
    exitBtn.appendChild(createElement(X, { width: 16, height: 16 }));
    exitBtn.setAttribute('aria-label', 'Exit fullscreen');

    zoomIn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.fullscreenSession !== session) return;
      session.zoom = Math.min(4, session.zoom + 0.5);
      this.applyFullscreenTransform(session);
    });

    zoomOut.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.fullscreenSession !== session) return;
      session.zoom = Math.max(0.25, session.zoom - 0.5);
      this.applyFullscreenTransform(session);
    });

    reset.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.fullscreenSession !== session) return;
      session.zoom = 1;
      session.panX = 0;
      session.panY = 0;
      this.applyFullscreenTransform(session);
    });

    exitBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.exitFullscreen('user-close', session);
    });

    controls.appendChild(zoomIn);
    controls.appendChild(zoomOut);
    controls.appendChild(reset);
    controls.appendChild(exitBtn);

    return controls;
  }

  applyFullscreenTransform(session: MermaidFullscreenSession): void {
    if (this.fullscreenSession !== session) return;
    const { svgWrapper, container } = session;
    const scale = (session.baseScale || 1) * session.zoom;
    svgWrapper.style.transform = `translate(${session.panX}px, ${session.panY}px) scale(${scale})`;

    const svg = svgWrapper.querySelector<SVGSVGElement>('svg');
    if (!svg) return;
    const viewport = container.getBoundingClientRect();
    const diagram = svg.getBoundingClientRect();
    let correctionX = 0;
    let correctionY = 0;

    if (diagram.width >= viewport.width) {
      if (diagram.left > viewport.left) correctionX = viewport.left - diagram.left;
      else if (diagram.right < viewport.right) correctionX = viewport.right - diagram.right;
    } else {
      if (diagram.left < viewport.left) correctionX = viewport.left - diagram.left;
      else if (diagram.right > viewport.right) correctionX = viewport.right - diagram.right;
    }
    if (diagram.height >= viewport.height) {
      if (diagram.top > viewport.top) correctionY = viewport.top - diagram.top;
      else if (diagram.bottom < viewport.bottom) correctionY = viewport.bottom - diagram.bottom;
    } else {
      if (diagram.top < viewport.top) correctionY = viewport.top - diagram.top;
      else if (diagram.bottom > viewport.bottom) correctionY = viewport.bottom - diagram.bottom;
    }

    if (correctionX !== 0 || correctionY !== 0) {
      session.panX += correctionX;
      session.panY += correctionY;
      svgWrapper.style.transform = `translate(${session.panX}px, ${session.panY}px) scale(${scale})`;
    }
  }

  attachFullscreenInteractions(session: MermaidFullscreenSession): void {
    const { svgWrapper, container } = session;
    let lastMouseX = 0;
    let lastMouseY = 0;

    const onPointerDown = (event: PointerEvent) => {
      if (this.fullscreenSession !== session) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.meo-mermaid-zoom-controls')) return;
      if (target?.closest('.meo-mermaid-zoom-btn')) return;
      if (event.button !== 0) return;

      container.style.cursor = 'grabbing';
      session.pointerId = event.pointerId;
      container.setPointerCapture(event.pointerId);
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (this.fullscreenSession !== session || session.pointerId !== event.pointerId) return;
      const dx = event.clientX - lastMouseX;
      const dy = event.clientY - lastMouseY;
      session.panX += dx;
      session.panY += dy;
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
      this.applyFullscreenTransform(session);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (session.pointerId !== event.pointerId) return;
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      session.pointerId = null;
      container.style.cursor = 'grab';
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (this.fullscreenSession !== session) return;
      const delta = event.deltaY > 0 ? -0.25 : 0.25;
      const newZoom = Math.max(0.25, Math.min(4, session.zoom + delta));
      const scaleRatio = newZoom / session.zoom;
      const rect = container.getBoundingClientRect();
      const pointX = event.clientX - (rect.left + rect.width / 2);
      const pointY = event.clientY - (rect.top + rect.height / 2);
      session.panX = pointX - (pointX - session.panX) * scaleRatio;
      session.panY = pointY - (pointY - session.panY) * scaleRatio;
      session.zoom = newZoom;
      this.applyFullscreenTransform(session);
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
    container.addEventListener('wheel', onWheel, { passive: false });

    session.cleanup = () => {
      let pointerCaptureError: unknown = null;
      try {
        if (session.pointerId !== null && container.hasPointerCapture(session.pointerId)) {
          container.releasePointerCapture(session.pointerId);
        }
      } catch (error) {
        pointerCaptureError = error;
      } finally {
        session.pointerId = null;
      }
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('wheel', onWheel);
      if (pointerCaptureError) throw pointerCaptureError;
    };
  }

  exitFullscreen(
    cause: MermaidFullscreenExitCause,
    expectedSession: MermaidFullscreenSession | null = this.fullscreenSession
  ): void {
    const session = this.fullscreenSession;
    if (!session || session !== expectedSession) return;
    this.fullscreenSession = null;

    const cleanupErrors: unknown[] = [];
    try {
      session.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      document.removeEventListener('keydown', session.keydown);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      session.overlay.remove();
    } catch (error) {
      cleanupErrors.push(error);
    }

    const isUserExit = cause === 'user-close' || cause === 'escape';
    const embeddedIsCurrent = session.embedded.wrapper.isConnected
      && this.presentationHandle === session.embedded.presentation;
    if (isUserExit && embeddedIsCurrent) {
      this.zoom = session.embedded.zoom;
      this.panX = session.embedded.panX;
      this.panY = session.embedded.panY;
      session.embedded.wrapper.style.transform = session.embedded.transform;
      if (
        session.embedded.scroller?.isConnected &&
        session.embedded.scrollTop !== null &&
        Math.abs(session.embedded.scroller.scrollTop - session.embedded.scrollTop) > 1
      ) {
        session.embedded.scroller.scrollTop = session.embedded.scrollTop;
      }
      try {
        if (session.embedded.focus?.isConnected) {
          session.embedded.focus.focus({ preventScroll: true });
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Mermaid fullscreen ${cause} cleanup failed`,
        { cause: cleanupErrors[0] }
      );
    }
  }

  setZoom(
    svgContainer: HTMLElement,
    newZoom: number,
    centerX: number | null = null,
    centerY: number | null = null
  ): void {
    if (centerX !== null && centerY !== null) {
      const rect = svgContainer.getBoundingClientRect();
      const parent = svgContainer.parentElement;
      if (!parent) {
        throw new Error('Mermaid zoom target must be mounted');
      }
      const containerRect = parent.getBoundingClientRect();

      const pointX = centerX - (rect.left - containerRect.left);
      const pointY = centerY - (rect.top - containerRect.top);

      const scale = newZoom / this.zoom;
      this.panX = pointX - (pointX - this.panX) * scale;
      this.panY = pointY - (pointY - this.panY) * scale;
    }

    this.zoom = newZoom;
    this.applyTransform(svgContainer);
  }

  applyTransform(svgContainer: HTMLElement): void {
    svgContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  renderError(container: HTMLElement, errorMsg: string): void {
    const fallback = document.createElement('pre');
    fallback.className = 'meo-mermaid-fallback';
    const code = document.createElement('code');
    code.textContent = this.diagramText;
    fallback.appendChild(code);

    const badge = document.createElement('div');
    badge.className = 'meo-mermaid-error-badge';
    badge.textContent = `Mermaid error: ${errorMsg}`;

    container.appendChild(fallback);
    container.appendChild(badge);
  }

  ignoreEvent() {
    return true;
  }

  destroy() {
    const errors: unknown[] = [];
    try {
      this.presentationHandle?.dispose();
    } catch (error) {
      errors.push(error);
    } finally {
      this.presentationHandle = null;
    }
    try {
      this.previewResizeObserver?.disconnect();
    } catch (error) {
      errors.push(error);
    } finally {
      this.previewResizeObserver = null;
    }
    try {
      this.exitFullscreen('dispose');
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Mermaid diagram widget disposal failed', { cause: errors[0] });
    }
  }
}
