import { WidgetType, type EditorView } from '@codemirror/view';
import { createElement, ZoomIn, ZoomOut, RotateCcw, Maximize2, X } from 'lucide';
import type { EditorState } from '@codemirror/state';
import { getViewportController } from './viewportController';
import { applyLiveBlockIndent } from './blockIndent';

declare global {
  interface Window {
    mermaid?: MermaidRuntime;
  }
  var mermaid: MermaidRuntime | undefined;
}

interface MermaidRuntime {
  initialize(config: any): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

interface MermaidResult {
  svg?: string;
  error?: string;
}

let mermaidInitialized = false;
let mermaidThemeSignature = '';
type MermaidOperationPriority = 'normal' | 'high';
type MermaidOperationJob = {
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

let mermaidOperationRunning = false;
const mermaidHighPriorityOperations: MermaidOperationJob[] = [];
const mermaidNormalPriorityOperations: MermaidOperationJob[] = [];
const MERMAID_CACHE_LIMIT = 100;
const mermaidCache = new Map<string, MermaidResult>();
const mermaidRenderInFlight = new Map<string, Promise<MermaidResult>>();
const mermaidEstimatedHeightCache = new Map<string, number>();
const mermaidPreviewHeightCache = new WeakMap<HTMLElement, Map<string, number>>();
let mermaidIdCounter = 0;
const MERMAID_MATH_CLASS = 'meoMath';
const MERMAID_DIAGRAM_START_RE =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|c4Context|xychart(?:-beta)?|sankey-beta|block-beta|packet-beta|radar-beta)\b/i;
const MERMAID_DISPLAY_MATH_RE = /^\$\$[\s\S]*\$\$$/;
const DISPLAY_MATH_VIEWBOX_PADDING = {
  left: 22,
  top: 20,
  right: 12,
  bottom: 12
} as const;
const DISPLAY_MATH_TRIM_RETRY_DELAYS_MS = [80, 220];
const DISPLAY_MATH_LABEL_SELECTORS = [
  '.nodeLabel .katex-mathml math',
  '.nodeLabel .katex-html',
  '.nodeLabel .katex-display',
  '.nodeLabel'
];
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

function mermaidPreviewHeightCacheKey(
  diagramText: string,
  themeSignature: string,
  startLine: number,
  layoutSignature: string
): string {
  return `${startLine}\n${themeSignature}\n${layoutSignature}\n${diagramText}`;
}

export function getCachedMermaidPreviewHeight(
  view: EditorView,
  diagramText: string,
  startLine: number
): number | null {
  const key = mermaidPreviewHeightCacheKey(
    diagramText,
    getMermaidThemeConfig().signature,
    startLine,
    mermaidLayoutSignature(view.contentDOM)
  );
  return mermaidPreviewHeightCache.get(view.dom)?.get(key) ?? null;
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

function getMermaidThemeConfig() {
  const bodyStyles = getComputedStyle(document.body);
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
    darkMode ? 'dark' : 'light'
  ].join('|');

  return {
    signature,
    config: {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
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
        darkMode
      },
      htmlLabels: true,
      markdownAutoWrap: true,
      flowchart: {
        htmlLabels: true
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

async function initMermaid() {
  const runtime = await loadMermaidRuntime();
  const { signature, config } = getMermaidThemeConfig();
  if (mermaidInitialized && mermaidThemeSignature === signature) {
    return runtime;
  }

  runtime.initialize(config);
  mermaidThemeSignature = signature;
  mermaidInitialized = true;
  return runtime;
}

function getCachedMermaidResult(cacheKey: string): MermaidResult | null {
  const cached = mermaidCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  mermaidCache.delete(cacheKey);
  mermaidCache.set(cacheKey, cached);
  return cached;
}

export async function restoreMermaidEditorTheme(): Promise<void> {
  const runtime = await loadMermaidRuntime();
  const { signature, config } = getMermaidThemeConfig();
  runtime.initialize(config);
  mermaidThemeSignature = signature;
  mermaidInitialized = true;
}

function runNextMermaidOperation(): void {
  if (mermaidOperationRunning) return;
  const job = mermaidHighPriorityOperations.shift() ?? mermaidNormalPriorityOperations.shift();
  if (!job) return;
  mermaidOperationRunning = true;
  void job.operation()
    .then(job.resolve, job.reject)
    .finally(() => {
      mermaidOperationRunning = false;
      runNextMermaidOperation();
    });
}

export function runExclusiveMermaidOperation<T>(
  operation: () => Promise<T>,
  priority: MermaidOperationPriority = 'normal'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: MermaidOperationJob = {
      operation,
      resolve: (value) => resolve(value as T),
      reject
    };
    (priority === 'high' ? mermaidHighPriorityOperations : mermaidNormalPriorityOperations).push(job);
    runNextMermaidOperation();
  });
}

function mermaidResultCacheKey(diagramText: string, themeSignature = getMermaidThemeConfig().signature): string {
  return `${themeSignature}\n${diagramText}`;
}

function currentMermaidContentWidth(element?: HTMLElement): number {
  const ownContent = element?.closest<HTMLElement>('.cm-content');
  if (ownContent && ownContent.clientWidth > 0) return ownContent.clientWidth;
  return Array.from(
    document.querySelectorAll<HTMLElement>('.editor-host > .cm-editor .cm-content')
  ).find((content) => content.clientWidth > 0)?.clientWidth ?? 0;
}

function mermaidEstimatedHeightKey(resultCacheKey: string, contentWidth: number): string {
  return `${resultCacheKey}\nwidth:${Math.max(0, Math.round(contentWidth))}`;
}

function cacheMermaidEstimatedHeight(cacheKey: string, height: number): void {
  mermaidEstimatedHeightCache.delete(cacheKey);
  mermaidEstimatedHeightCache.set(cacheKey, height);
  if (mermaidEstimatedHeightCache.size > MERMAID_CACHE_LIMIT) {
    const oldestKey = mermaidEstimatedHeightCache.keys().next().value;
    if (oldestKey) mermaidEstimatedHeightCache.delete(oldestKey);
  }
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

function cacheMermaidResult(cacheKey: string, result: MermaidResult): void {
  if (mermaidCache.has(cacheKey)) {
    mermaidCache.delete(cacheKey);
  }
  mermaidCache.set(cacheKey, result);

  if (mermaidCache.size <= MERMAID_CACHE_LIMIT) {
    return;
  }

  const oldestKey = mermaidCache.keys().next().value;
  if (oldestKey !== undefined) {
    mermaidCache.delete(oldestKey);
  }
}

async function renderMermaidDiagram(diagramText: string): Promise<MermaidResult> {
  const normalizedDiagramText = normalizeMermaidDiagramText(diagramText);
  const { signature } = getMermaidThemeConfig();
  const cacheKey = mermaidResultCacheKey(diagramText, signature);
  const cached = getCachedMermaidResult(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = mermaidRenderInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const id = `mermaid-${++mermaidIdCounter}`;
  const renderPromise: Promise<MermaidResult> = runExclusiveMermaidOperation(async () => {
    const runtime = await initMermaid();
    return runtime.render(id, normalizedDiagramText);
  })
    .then(({ svg }) => {
      const result: MermaidResult = { svg };
      cacheMermaidResult(cacheKey, result);
      return result;
    })
    .catch((err) => {
      const result: MermaidResult = { error: err.message || String(err) };
      cacheMermaidResult(cacheKey, result);
      return result;
    })
    .finally(() => {
      mermaidRenderInFlight.delete(cacheKey);
    });

  mermaidRenderInFlight.set(cacheKey, renderPromise);
  return renderPromise;
}

export function refreshMermaidTheme(): void {
  mermaidCache.clear();
  mermaidRenderInFlight.clear();
  mermaidEstimatedHeightCache.clear();
  mermaidInitialized = false;
  mermaidThemeSignature = '';
}

export function isDisplayMathDiagram(diagramText: string): boolean {
  return MERMAID_DISPLAY_MATH_RE.test(diagramText.trim());
}

function compactDisplayMath(diagramText) {
  const inner = diagramText.trim().slice(2, -2).trim();
  const singleLine = inner
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return `$$${singleLine}$$`;
}

function escapeForMermaidLabel(text) {
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

export function getFencedCodeContent(state: EditorState, node: any): string {
  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(Math.max(node.to - 1, node.from));

  const lines: string[] = [];
  let inContent = false;

  for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum += 1) {
    const line = state.doc.line(lineNum);
    const lineText = state.doc.sliceString(line.from, line.to);

    if (!inContent) {
      if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(lineText)) {
        inContent = true;
      }
      continue;
    }

    if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(lineText)) {
      break;
    }

    lines.push(lineText);
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
  isDragging: boolean;
  lastMouseX: number;
  lastMouseY: number;
  isFullscreen: boolean;
  fullscreenOverlay: HTMLElement | null;
  svgContent: string | null;
  fullscreenBaseScale: number;
  inlineCleanup: (() => void) | null;
  fullscreenSvgWrapper: HTMLElement | null;
  fullscreenCleanup: (() => void) | null;
  exitFullscreenHandler: ((e: KeyboardEvent) => void) | null;
  themeSignature: string;
  cachePreviewHeight: boolean;
  previewResizeObserver: ResizeObserver | null;
  measuredHeight: number;
  indentColumns: number;

  constructor(
    diagramText: string,
    startLine: number = 0,
    endLine: number = 0,
    options: { cachePreviewHeight?: boolean; indentColumns?: number } = {}
  ) {
    super();
    this.diagramText = diagramText;
    this.startLine = startLine;
    this.endLine = endLine;
    this.isDisplayMath = isDisplayMathDiagram(diagramText);
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.isFullscreen = false;
    this.fullscreenOverlay = null;
    this.svgContent = null;
    this.fullscreenBaseScale = 1;
    this.inlineCleanup = null;
    this.fullscreenSvgWrapper = null;
    this.fullscreenCleanup = null;
    this.exitFullscreenHandler = null;
    this.themeSignature = getMermaidThemeConfig().signature;
    this.cachePreviewHeight = options.cachePreviewHeight ?? true;
    this.indentColumns = options.indentColumns ?? 0;
    this.previewResizeObserver = null;
    const resultCacheKey = mermaidResultCacheKey(this.diagramText, this.themeSignature);
    const contentWidth = currentMermaidContentWidth();
    this.measuredHeight = mermaidEstimatedHeightCache.get(
      mermaidEstimatedHeightKey(resultCacheKey, contentWidth)
    ) ?? estimateCachedMermaidHeight(mermaidCache.get(resultCacheKey)?.svg, contentWidth);
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
          const cacheKey = mermaidPreviewHeightCacheKey(
            this.diagramText,
            this.themeSignature,
            this.startLine,
            mermaidLayoutSignature(content)
          );
          this.measuredHeight = height;
          cacheMermaidEstimatedHeight(
            mermaidEstimatedHeightKey(
              mermaidResultCacheKey(this.diagramText, this.themeSignature),
              currentMermaidContentWidth(container)
            ),
            height
          );
          let viewCache = mermaidPreviewHeightCache.get(view.dom);
          if (!viewCache) {
            viewCache = new Map();
            mermaidPreviewHeightCache.set(view.dom, viewCache);
          }
          viewCache.delete(cacheKey);
          viewCache.set(cacheKey, height);
          if (viewCache.size > MERMAID_CACHE_LIMIT) {
            const oldestKey = viewCache.keys().next().value;
            if (oldestKey) {
              viewCache.delete(oldestKey);
            }
          }
        }
      });
      this.previewResizeObserver.observe(container);
    }

    const cached = getCachedMermaidResult(mermaidResultCacheKey(this.diagramText, this.themeSignature));
    if (cached) {
      if (cached.error) {
        this.renderError(container, cached.error);
      } else {
        this.renderSvg(container, cached.svg);
      }
      return container;
    }

    const loading = document.createElement('div');
    loading.className = 'meo-mermaid-loading';
    loading.textContent = 'Loading...';
    container.appendChild(loading);

    (async () => {
      const result = await renderMermaidDiagram(this.diagramText);
      if (!container.contains(loading)) {
        return;
      }
      const showResult = () => {
        container.removeChild(loading);
        if (result.error) this.renderError(container, result.error);
        else this.renderSvg(container, result.svg);
      };
      if (!view || !container.isConnected) {
        showResult();
        return;
      }
      const controller = getViewportController(view);
      if (!controller || this.startLine <= 0 || this.endLine <= 0) {
        showResult();
        view.requestMeasure();
        return;
      }
      const startLine = view.state.doc.line(Math.min(this.startLine, view.state.doc.lines));
      const endLine = view.state.doc.line(Math.min(this.endLine, view.state.doc.lines));
      controller.preserveLayoutChange({
        element: container,
        from: startLine.from,
        to: endLine.to
      }, showResult);
    })();

    return container;
  }

  renderSvg(container, svgContent) {
    const svgWrapper = document.createElement('div');
    svgWrapper.className = 'meo-mermaid-svg-wrapper';
    svgWrapper.innerHTML = svgContent;
    if (container.classList.contains('meo-mermaid-light-theme')) {
      this.applyLightThemeSvgOverrides(svgWrapper);
    }

    container.appendChild(svgWrapper);
    if (this.isDisplayMath) {
      this.trimDisplayMathSvg(svgWrapper);
      return;
    }

    const controls = this.createZoomControls(svgWrapper);
    container.appendChild(controls);

    this.attachInteractions(svgWrapper, container);
  }

  applyLightThemeSvgOverrides(svgWrapper) {
    const nodeShapes = svgWrapper.querySelectorAll(
      '.node rect, .node polygon, .node ellipse, .node circle, .node path, .label-container'
    );
    for (const shape of nodeShapes) {
      if (shape instanceof SVGElement) {
        shape.style.setProperty('fill', '#ffffff', 'important');
        shape.style.setProperty('stroke', '#6e7781', 'important');
      }
    }

    const labels = svgWrapper.querySelectorAll('.nodeLabel, .label, .edgeLabel, .edgeLabel p');
    for (const label of labels) {
      if (label instanceof HTMLElement || label instanceof SVGElement) {
        label.style.setProperty('color', '#1f2328', 'important');
      }
    }

    const edgeLabels = svgWrapper.querySelectorAll('.edgeLabel rect, .labelBkg');
    for (const edgeLabel of edgeLabels) {
      if (edgeLabel instanceof SVGElement) {
        edgeLabel.style.setProperty('fill', 'var(--meo-code-background)', 'important');
      }
    }

    const edgePaths = svgWrapper.querySelectorAll('.edgePaths path, .flowchart-link');
    for (const edgePath of edgePaths) {
      if (edgePath instanceof SVGElement) {
        edgePath.style.setProperty('stroke', '#6e7781', 'important');
      }
    }

    const markers = svgWrapper.querySelectorAll('.marker, marker path');
    for (const marker of markers) {
      if (marker instanceof SVGElement) {
        marker.style.setProperty('fill', '#6e7781', 'important');
        marker.style.setProperty('stroke', '#6e7781', 'important');
      }
    }
  }

  trimDisplayMathSvg(svgWrapper) {
    let originalViewBox = null;

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

  getDisplayMathContentBox(svg) {
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

    const labelNodes = svg.querySelectorAll(DISPLAY_MATH_LABEL_SELECTOR);
    const points = [];
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

  transformClientPointToSvg(svg, inverseCtm, x, y) {
    if (typeof DOMPoint === 'function') {
      return new DOMPoint(x, y).matrixTransform(inverseCtm);
    }
    const point = svg.createSVGPoint();
    point.x = x;
    point.y = y;
    return point.matrixTransform(inverseCtm);
  }

  getSvgContentBox(svg) {
    if (typeof svg.getBBox !== 'function') {
      return null;
    }
    try {
      const contentNode = svg.querySelector('.nodes') ?? svg;
      return contentNode.getBBox();
    } catch {
      return null;
    }
  }

  getSvgViewBox(svg) {
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

  parseSvgLength(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  createZoomControls(svgContainer) {
    const controls = document.createElement('div');
    controls.className = 'meo-mermaid-zoom-controls';
    applyMermaidThemeClass(controls);

    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'meo-mermaid-zoom-btn';
    zoomIn.appendChild(createElement(ZoomIn, { width: 16, height: 16 }));
    zoomIn.setAttribute('aria-label', 'Zoom in');

    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'meo-mermaid-zoom-btn';
    zoomOut.appendChild(createElement(ZoomOut, { width: 16, height: 16 }));
    zoomOut.setAttribute('aria-label', 'Zoom out');

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'meo-mermaid-zoom-btn';
    reset.appendChild(createElement(RotateCcw, { width: 16, height: 16 }));
    reset.setAttribute('aria-label', 'Reset zoom');

    const fullscreen = document.createElement('button');
    fullscreen.type = 'button';
    fullscreen.className = 'meo-mermaid-zoom-btn';
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

  toggleFullscreen(svgContainer) {
    if (this.isFullscreen) {
      this.exitFullscreen();
    } else {
      this.enterFullscreen(svgContainer);
    }
  }

  enterFullscreen(svgContainer) {
    if (this.isFullscreen) {
      return;
    }
    this.isFullscreen = true;
    this.svgContent = svgContainer.innerHTML;

    const overlay = document.createElement('div');
    overlay.className = 'meo-mermaid-fullscreen-scrim';

    const fullscreenContainer = document.createElement('div');
    fullscreenContainer.className = 'meo-mermaid-fullscreen';
    applyMermaidThemeClass(fullscreenContainer);

    const svgWrapper = document.createElement('div');
    svgWrapper.className = 'meo-mermaid-svg-wrapper';
    svgWrapper.innerHTML = this.svgContent;
    if (fullscreenContainer.classList.contains('meo-mermaid-light-theme')) {
      this.applyLightThemeSvgOverrides(svgWrapper);
    }

    fullscreenContainer.appendChild(svgWrapper);

    const controls = this.createFullscreenControls(svgWrapper);
    fullscreenContainer.appendChild(controls);

    this.attachFullscreenInteractions(svgWrapper, fullscreenContainer);

    overlay.appendChild(fullscreenContainer);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
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
          this.fullscreenBaseScale = Math.min(scaleX, scaleY);
        } else {
          this.fullscreenBaseScale = 1;
        }

        svgWrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.fullscreenBaseScale * this.zoom})`;
      }
    });

    this.fullscreenOverlay = overlay;
    this.fullscreenSvgWrapper = svgWrapper;

    this.exitFullscreenHandler = (e) => {
      if (e.key === 'Escape') {
        this.exitFullscreen();
      }
    };
    document.addEventListener('keydown', this.exitFullscreenHandler);
  }

  createFullscreenControls(svgContainer) {
    const controls = document.createElement('div');
    controls.className = 'meo-mermaid-zoom-controls meo-mermaid-fullscreen-controls';
    applyMermaidThemeClass(controls);

    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'meo-mermaid-zoom-btn';
    zoomIn.appendChild(createElement(ZoomIn, { width: 16, height: 16 }));
    zoomIn.setAttribute('aria-label', 'Zoom in');

    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'meo-mermaid-zoom-btn';
    zoomOut.appendChild(createElement(ZoomOut, { width: 16, height: 16 }));
    zoomOut.setAttribute('aria-label', 'Zoom out');

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'meo-mermaid-zoom-btn';
    reset.appendChild(createElement(RotateCcw, { width: 16, height: 16 }));
    reset.setAttribute('aria-label', 'Reset zoom');

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'meo-mermaid-zoom-btn meo-mermaid-exit-btn';
    exitBtn.appendChild(createElement(X, { width: 16, height: 16 }));
    exitBtn.setAttribute('aria-label', 'Exit fullscreen');

    zoomIn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.zoom = Math.min(4, this.zoom + 0.5);
      const scale = (this.fullscreenBaseScale || 1) * this.zoom;
      svgContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${scale})`;
    });

    zoomOut.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.zoom = Math.max(0.25, this.zoom - 0.5);
      const scale = (this.fullscreenBaseScale || 1) * this.zoom;
      svgContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${scale})`;
    });

    reset.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      const scale = (this.fullscreenBaseScale || 1) * this.zoom;
      svgContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${scale})`;
    });

    exitBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.exitFullscreen();
    });

    controls.appendChild(zoomIn);
    controls.appendChild(zoomOut);
    controls.appendChild(reset);
    controls.appendChild(exitBtn);

    return controls;
  }

  attachFullscreenInteractions(svgWrapper, container) {
    let isDragging = false;
    let lastMouseX = 0;
    let lastMouseY = 0;

    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('.meo-mermaid-zoom-controls')) return;
      if (e.target.closest('.meo-mermaid-zoom-btn')) return;
      if (e.button !== 0) return;

      container.style.cursor = 'grabbing';
      isDragging = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    });

    const onMouseMove = (e) => {
      if (!isDragging) {
        return;
      }
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      this.panX += dx;
      this.panY += dy;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      const scale = (this.fullscreenBaseScale || 1) * this.zoom;
      svgWrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${scale})`;
    };

    const onMouseUp = () => {
      isDragging = false;
      container.style.cursor = 'grab';
    };

    const onWheel = (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.25 : 0.25;
      this.zoom = Math.max(0.25, Math.min(4, this.zoom + delta));
      const scale = (this.fullscreenBaseScale || 1) * this.zoom;
      svgWrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${scale})`;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    container.addEventListener('wheel', onWheel, { passive: false });

    this.fullscreenCleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      container.removeEventListener('wheel', onWheel);
    };
  }

  exitFullscreen() {
    if (!this.isFullscreen) {
      return;
    }
    this.isFullscreen = false;

    if (this.fullscreenCleanup) {
      this.fullscreenCleanup();
      this.fullscreenCleanup = null;
    }

    if (this.fullscreenOverlay) {
      this.fullscreenOverlay.remove();
      this.fullscreenOverlay = null;
      this.fullscreenSvgWrapper = null;
    }

    if (this.exitFullscreenHandler) {
      document.removeEventListener('keydown', this.exitFullscreenHandler);
      this.exitFullscreenHandler = null;
    }
  }

  setZoom(svgContainer, newZoom, centerX = null, centerY = null) {
    if (centerX !== null && centerY !== null) {
      const rect = svgContainer.getBoundingClientRect();
      const containerRect = svgContainer.parentElement.getBoundingClientRect();

      const pointX = centerX - (rect.left - containerRect.left);
      const pointY = centerY - (rect.top - containerRect.top);

      const scale = newZoom / this.zoom;
      this.panX = pointX - (pointX - this.panX) * scale;
      this.panY = pointY - (pointY - this.panY) * scale;
    }

    this.zoom = newZoom;
    this.applyTransform(svgContainer);
  }

  applyTransform(svgContainer) {
    svgContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  attachInteractions(svgWrapper, container) {
    if (this.inlineCleanup) {
      this.inlineCleanup();
      this.inlineCleanup = null;
    }

    const onMouseDown = (e) => {
      if (e.target.closest('.meo-mermaid-zoom-controls')) return;
      if (e.target.closest('.meo-mermaid-zoom-btn')) return;
      if (e.button !== 0) return;

      container.style.cursor = 'grabbing';
      container.classList.add('meo-mermaid-dragging');
      this.isDragging = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    };

    const onMouseMove = (e) => {
      if (!this.isDragging) {
        return;
      }
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.panX += dx;
      this.panY += dy;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.applyTransform(svgWrapper);
    };

    const onMouseUp = () => {
      this.isDragging = false;
      container.style.cursor = 'grab';
      container.classList.remove('meo-mermaid-dragging');
    };

    container.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    this.inlineCleanup = () => {
      container.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }

  renderError(container, errorMsg) {
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
    return false;
  }

  destroy() {
    this.previewResizeObserver?.disconnect();
    this.previewResizeObserver = null;
    if (this.inlineCleanup) {
      this.inlineCleanup();
      this.inlineCleanup = null;
    }
    this.exitFullscreen();
  }
}
