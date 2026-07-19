import type { PreviewAppearance } from '../../../src/shared/preview';
import {
  loadMermaidRuntime,
  isDisplayMathDiagram,
  normalizeMermaidDiagramText,
  restoreMermaidEditorTheme,
  runExclusiveMermaidOperation
} from './mermaidDiagram';

const PREVIEW_MERMAID_CACHE_LIMIT = 100;
const previewMermaidSvgCache = new Map<string, string>();

type PreviewMermaidPalette = {
  background: string;
  nodeBackground: string;
  foreground: string;
  border: string;
  line: string;
};

export function createPreviewMermaidRenderer() {
  let renderQueue: Promise<void> = Promise.resolve();

  const render = (
    frameDocument: Document,
    appearance: PreviewAppearance,
    onDiagramRendered?: () => void
  ): Promise<void> => {
    renderQueue = renderQueue
      .catch(() => undefined)
      .then(() => runExclusiveMermaidOperation(async () => {
        try {
          await renderMermaidBlocks(frameDocument, appearance, onDiagramRendered);
        } finally {
          await restoreMermaidEditorTheme();
        }
      }, 'high'));
    return renderQueue;
  };

  return { render };
}

async function renderMermaidBlocks(
  frameDocument: Document,
  appearance: PreviewAppearance,
  onDiagramRendered?: () => void
): Promise<void> {
  const viewportCenter = (frameDocument.defaultView?.innerHeight ?? 0) / 2;
  const blocks = Array.from(frameDocument.querySelectorAll<HTMLElement>('.meo-export-mermaid[data-source-b64]'))
    .map((block, documentIndex) => ({ block, documentIndex }))
    .sort((left, right) =>
      Math.abs(left.block.getBoundingClientRect().top - viewportCenter)
      - Math.abs(right.block.getBoundingClientRect().top - viewportCenter)
    );
  if (blocks.length === 0) return;

  const mermaid = await loadMermaidRuntime();
  const palette = readPreviewMermaidPalette(frameDocument, appearance);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      background: palette.background,
      mainBkg: palette.nodeBackground,
      secondBkg: palette.nodeBackground,
      tertiaryColor: palette.nodeBackground,
      primaryColor: palette.nodeBackground,
      primaryTextColor: palette.foreground,
      primaryBorderColor: palette.border,
      nodeBorder: palette.border,
      lineColor: palette.line,
      textColor: palette.foreground,
      nodeTextColor: palette.foreground,
      edgeLabelBackground: palette.background,
      clusterBkg: palette.background,
      clusterBorder: palette.border,
      titleColor: palette.foreground,
      darkMode: appearance === 'dark'
    },
    htmlLabels: true,
    markdownAutoWrap: true,
    flowchart: { htmlLabels: true },
    legacyMathML: true,
    forceLegacyMathML: true
  });

  let renderIndex = 0;
  for (const { block, documentIndex } of blocks) {
    const source = decodeBase64Utf8(block.dataset.sourceB64 ?? '');
    if (!source) continue;

    const cacheKey = [
      appearance,
      palette.background,
      palette.nodeBackground,
      palette.foreground,
      palette.border,
      palette.line,
      `block:${documentIndex}`,
      source
    ].join('\n');

    try {
      const cachedSvg = previewMermaidSvgCache.get(cacheKey);
      const normalizedSource = normalizeMermaidDiagramText(source);
      const result = cachedSvg
        ? { svg: cachedSvg }
        : await mermaid.render(`meo-preview-mermaid-${Date.now()}-${renderIndex += 1}`, normalizedSource);
      const svg = typeof result === 'string' ? result : result?.svg;
      if (!svg) continue;

      cachePreviewMermaidSvg(cacheKey, svg);
      block.classList.toggle('is-math', isDisplayMathDiagram(source));
      block.classList.add('is-rendered');
      block.classList.remove('is-error');
      block.innerHTML = `<div class="meo-export-mermaid-svg">${svg}</div>`;
      onDiagramRendered?.();
    } catch {
      block.classList.add('is-error');
    }
  }
}

function readPreviewMermaidPalette(
  frameDocument: Document,
  appearance: PreviewAppearance
): PreviewMermaidPalette {
  const rootStyles = frameDocument.defaultView?.getComputedStyle(frameDocument.documentElement);
  const readColor = (name: string, fallback: string) => {
    const value = rootStyles?.getPropertyValue(name).trim() || fallback;
    const probe = frameDocument.createElement('span');
    probe.style.color = value;
    frameDocument.body.appendChild(probe);
    const resolved = frameDocument.defaultView?.getComputedStyle(probe).color || fallback;
    probe.remove();
    return normalizeMermaidColor(resolved, fallback);
  };

  return {
    background: readColor('--meo-mermaid-background', appearance === 'dark' ? '#20252b' : '#ffffff'),
    nodeBackground: readColor('--meo-mermaid-node-background', appearance === 'dark' ? '#2b333b' : '#f6f8fa'),
    foreground: readColor('--meo-mermaid-foreground', appearance === 'dark' ? '#e6edf3' : '#24292f'),
    border: readColor('--meo-mermaid-border', appearance === 'dark' ? '#768390' : '#8c959f'),
    line: readColor('--meo-mermaid-line', appearance === 'dark' ? '#8b949e' : '#57606a')
  };
}

function normalizeMermaidColor(value: string, fallback: string): string {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i.exec(value);
  if (!srgb) return value;
  const channels = srgb.slice(1, 4).map((channel) => Math.round(Number(channel) * 255));
  if (channels.some((channel) => !Number.isFinite(channel))) return fallback;
  const alpha = srgb[4] === undefined ? 1 : Number(srgb[4]);
  return alpha >= 1
    ? `rgb(${channels.join(', ')})`
    : `rgba(${channels.join(', ')}, ${Number.isFinite(alpha) ? alpha : 1})`;
}

function cachePreviewMermaidSvg(cacheKey: string, svg: string): void {
  previewMermaidSvgCache.delete(cacheKey);
  previewMermaidSvgCache.set(cacheKey, svg);
  if (previewMermaidSvgCache.size <= PREVIEW_MERMAID_CACHE_LIMIT) return;
  const oldestKey = previewMermaidSvgCache.keys().next().value;
  if (oldestKey) previewMermaidSvgCache.delete(oldestKey);
}

function decodeBase64Utf8(value: string): string {
  try {
    const binary = window.atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return '';
  }
}
