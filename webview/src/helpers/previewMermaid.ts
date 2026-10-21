import { syncPreviewRenderedActions } from './previewBlockActions';
import type { EditorAppearance } from '../../../src/protocol/editorCommands';
import { getGithubMermaidConfig } from '../../../src/preview/githubMermaid';
import { getMermaidColorVariables, getMermaidPalette } from '../../../src/shared/mermaidPalette';

type PreviewAppearance = Exclude<EditorAppearance, 'auto'>;
import {
  MermaidDiagramResourceUnavailableError,
  type MermaidDiagramRenderResources
} from '../application/mermaidDiagramRenderResources';
import {
  loadMermaidRuntime,
  renderMermaidSvgInDocument,
  isDisplayMathDiagram,
  normalizeMermaidDiagramText,
  restoreMermaidEditorTheme
} from './mermaidDiagram';

const PREVIEW_MERMAID_CACHE_LIMIT = 100;
const previewMermaidSvgCache = new Map<string, string>();

type PreviewMermaidPalette = ReturnType<typeof getMermaidPalette> & { background: string };

export function createPreviewMermaidRenderer(
  resources: MermaidDiagramRenderResources,
  reportError: (error: unknown) => void = () => undefined
) {
  let activeGroup: ReturnType<MermaidDiagramRenderResources['acquireGroup']> | null = null;
  let latestRenderGeneration = 0;
  let renderTail: Promise<void> = Promise.resolve();

  const render = (
    frameDocument: Document,
    appearance: PreviewAppearance,
    onDiagramRendered?: () => void,
    isCurrent: () => boolean = () => true,
    commit: (mutate: () => void) => void = (mutate) => mutate()
  ): Promise<void> => {
    const renderGeneration = latestRenderGeneration + 1;
    latestRenderGeneration = renderGeneration;
    activeGroup?.end();
    const preset = frameDocument.documentElement.dataset.meoPreviewPreset ?? 'default';
    const revision = frameDocument.documentElement.dataset.meoPreviewPresetRevision ?? '';
    // A preserved SVG can outlive a theme change with the same appearance.
    let themeKey: string | undefined;
    const hasPendingBlocks = Array.from(frameDocument.querySelectorAll<HTMLElement>(
      '.meo-export-mermaid[data-source-b64]'
    )).some((block) => (
      !block.classList.contains('is-rendered')
      || block.dataset.meoPreviewMermaidAppearance !== appearance
      || (block.dataset.meoPreviewMermaidPreset ?? 'default') !== preset
      || (block.dataset.meoPreviewMermaidPresetRevision ?? '') !== revision
      || block.dataset.meoPreviewMermaidTheme !== (themeKey ??= JSON.stringify(readPreviewMermaidPalette(frameDocument, appearance)))
    ));
    if (!hasPendingBlocks) return Promise.resolve();
    const scheduled = renderTail.catch(() => undefined).then(async () => {
      const requestIsCurrent = () => renderGeneration === latestRenderGeneration && isCurrent();
      if (!requestIsCurrent()) return;
      const group = resources.acquireGroup();
      activeGroup = group;
      try {
        await group.runExclusive(async () => {
          if (!requestIsCurrent()) return;
          try {
            await renderMermaidBlocks(
              frameDocument,
              appearance,
              onDiagramRendered,
              requestIsCurrent,
              commit
            );
          } finally {
            await restoreMermaidEditorTheme();
          }
        }, 'high');
      } catch (error) {
        if (!(error instanceof MermaidDiagramResourceUnavailableError)) reportError(error);
      } finally {
        group.end();
        if (activeGroup === group) activeGroup = null;
      }
    });
    renderTail = scheduled;
    return scheduled;
  };

  return {
    render,
    dispose() {
      latestRenderGeneration += 1;
      activeGroup?.end();
      activeGroup = null;
    }
  };
}

async function renderMermaidBlocks(
  frameDocument: Document,
  appearance: PreviewAppearance,
  onDiagramRendered: (() => void) | undefined,
  isCurrent: () => boolean,
  commit: (mutate: () => void) => void
): Promise<void> {
  if (!isCurrent()) return;
  syncPreviewRenderedActions(frameDocument);
  const preset = frameDocument.documentElement.dataset.meoPreviewPreset ?? 'default';
  const revision = frameDocument.documentElement.dataset.meoPreviewPresetRevision ?? '';
  const palette = readPreviewMermaidPalette(frameDocument, appearance);
  const themeKey = JSON.stringify(palette);
  const viewportCenter = (frameDocument.defaultView?.innerHeight ?? 0) / 2;
  const blocks = Array.from(frameDocument.querySelectorAll<HTMLElement>('.meo-export-mermaid[data-source-b64]'))
    .filter((block) => (
      !block.classList.contains('is-rendered')
      || block.dataset.meoPreviewMermaidAppearance !== appearance
      || (block.dataset.meoPreviewMermaidPreset ?? 'default') !== preset
      || (block.dataset.meoPreviewMermaidPresetRevision ?? '') !== revision
      || block.dataset.meoPreviewMermaidTheme !== themeKey
    ))
    .map((block, documentIndex) => ({ block, documentIndex }))
    .sort((left, right) =>
      Math.abs(left.block.getBoundingClientRect().top - viewportCenter)
      - Math.abs(right.block.getBoundingClientRect().top - viewportCenter)
    );
  if (blocks.length === 0) return;

  const mermaid = await loadMermaidRuntime();
  if (!isCurrent()) return;
  const github = frameDocument.documentElement.dataset.meoPreviewRenderer === 'github-readme' || preset === 'github-readme';
  mermaid.initialize(github ? getGithubMermaidConfig(appearance === 'dark') : {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look: 'classic',
    themeVariables: {
      ...getMermaidColorVariables(palette),
      sequenceNumberColor: appearance === 'dark' ? palette.chartTextColor : '#ffffff',
      ...Object.fromEntries(palette.chartColors.map((color, index) => [`pie${index + 1}`, color])),
      pieOpacity: 1,
      darkMode: appearance === 'dark'
    },
    htmlLabels: true,
    markdownAutoWrap: true,
    flowchart: { htmlLabels: true },
    legacyMathML: true,
    forceLegacyMathML: true
  });

  let renderIndex = 0;
  const prepared: Array<{ block: HTMLElement; source: string; svg: string }> = [];
  const failed: HTMLElement[] = [];
  for (const { block, documentIndex } of blocks) {
    // Mermaid's promises can resolve in one task. Let input and paint run
    // between diagrams while retaining the exclusive theme lease.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!isCurrent()) return;
    const source = decodeBase64Utf8(block.dataset.sourceB64 ?? '');
    if (!source) continue;

    const cacheKey = [
      preset,
      frameDocument.documentElement.dataset.meoPreviewPresetRevision ?? '',
      appearance,
      palette.background,
      palette.nodeBackground,
      palette.secondaryBackground,
      palette.tertiaryBackground,
      palette.clusterBackground,
      palette.foreground,
      palette.border,
      palette.line,
      ...palette.chartColors,
      palette.chartTextColor,
      `block:${documentIndex}`,
      source
    ].join('\n');

    try {
      const cachedSvg = previewMermaidSvgCache.get(cacheKey);
      const normalizedSource = normalizeMermaidDiagramText(source);
      const result = cachedSvg
        ? cachedSvg
        : await renderMermaidSvgInDocument(
            mermaid,
            `meo-preview-mermaid-${Date.now()}-${renderIndex += 1}`,
            normalizedSource,
            frameDocument
          );
      if (!isCurrent()) return;
      const svg = result;
      if (!svg) continue;

      cachePreviewMermaidSvg(cacheKey, svg);
      prepared.push({ block, source, svg });
    } catch {
      failed.push(block);
    }
  }
  if (!isCurrent() || (prepared.length === 0 && failed.length === 0)) return;
  commit(() => {
    if (!isCurrent()) return;
    for (const { block, source, svg } of prepared) {
      block.classList.toggle('is-math', isDisplayMathDiagram(source));
      block.classList.add('is-rendered');
      block.classList.remove('is-error');
      delete block.dataset.meoPreviewMermaidPending;
      block.dataset.meoPreviewMermaidAppearance = appearance;
      block.dataset.meoPreviewMermaidPreset = preset;
      block.dataset.meoPreviewMermaidPresetRevision = revision;
      block.dataset.meoPreviewMermaidTheme = themeKey;
      const copyActions = block.querySelector(':scope > .meo-preview-code-actions');
      const languageLabel = block.querySelector(':scope > .meo-export-code-language-label');
      block.innerHTML = `<div class="meo-export-mermaid-svg">${svg}</div>`;
      if (languageLabel) block.prepend(languageLabel);
      if (copyActions) block.append(copyActions);
    }
    for (const block of failed) {
      block.classList.add('is-error');
      delete block.dataset.meoPreviewMermaidPending;
    }
  });
  syncPreviewRenderedActions(frameDocument);
  onDiagramRendered?.();
}

function readPreviewMermaidPalette(
  frameDocument: Document,
  appearance: PreviewAppearance
): PreviewMermaidPalette {
  const palette = getMermaidPalette(appearance === 'dark');
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
    ...palette,
    background: readColor('--meo-mermaid-background', appearance === 'dark' ? '#20252b' : '#ffffff'),
    nodeBackground: readColor('--meo-mermaid-node-background', palette.nodeBackground),
    secondaryBackground: readColor('--meo-mermaid-secondary-background', palette.secondaryBackground),
    tertiaryBackground: readColor('--meo-mermaid-tertiary-background', palette.tertiaryBackground),
    clusterBackground: readColor('--meo-mermaid-cluster-background', palette.clusterBackground),
    foreground: readColor('--meo-mermaid-foreground', palette.foreground),
    border: readColor('--meo-mermaid-border', palette.border),
    line: readColor('--meo-mermaid-line', palette.line),
    chartColors: palette.chartColors.map((color, index) => readColor(`--meo-mermaid-chart-${index + 1}`, color)),
    chartTextColor: readColor('--meo-mermaid-chart-text', palette.chartTextColor)
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
