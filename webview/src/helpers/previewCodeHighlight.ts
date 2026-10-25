import {
  getShikiThemeMeta,
  getShikiTokens,
  getShikiThemeVersion,
  requestShikiTokens,
  resolveShikiLang
} from './shikiHighlighter';
import { projectShikiTokenLines, type ShikiPresentationRun } from '../../../src/shared/shikiTokenPresentation';
import { getPreviewViewportResources } from './previewViewportResources';
import { previewCodeSource } from './previewCodeSource';

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

/** Read geometry before token writes; wrapped rows need their actual heights. */
export function previewCodeReadingBand(lines: readonly HTMLElement[], height: number): readonly [number, number] {
  // Keep ordinary fences atomic, including a short fence straddling the band.
  if (lines.length <= 240) return [0, lines.length];
  let low = 0, high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.getBoundingClientRect().bottom < -height) low = middle + 1;
    else high = middle;
  }
  const from = low;
  high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.getBoundingClientRect().top <= height * 2) low = middle + 1;
    else high = middle;
  }
  return [from, low];
}

function applyTokenStyle(element: HTMLElement, run: ShikiPresentationRun): void {
  // Shiki has already resolved the active VS Code TextMate theme at token
  // scope precision. Reclassifying it here loses theme-specific distinctions.
  element.style.color = run.color ?? 'var(--meo-code-fg)';
  const fontStyle = run.fontStyle ?? 0;
  if (fontStyle & FONT_STYLE_ITALIC) element.style.fontStyle = 'italic';
  if (fontStyle & FONT_STYLE_BOLD) element.style.fontWeight = 'bold';
  if (fontStyle & FONT_STYLE_UNDERLINE) element.style.textDecoration = 'underline';
}

function getHighlightRequest(code: HTMLElement): {
  readonly language: string;
  readonly source: string;
  readonly sources: readonly HTMLElement[];
  readonly offset: number;
  readonly version: string;
} | null {
  const languageClass = Array.from(code.classList).find((name) => name.startsWith('language-'));
  const language = resolveShikiLang(languageClass?.slice('language-'.length));
  if (!language) return null;
  const sources = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-source'));
  if (sources.length === 0) return null;
  const context = previewCodeSource(code);
  return {
    language,
    source: context?.source ?? sources.map((line) => line.textContent ?? '').join('\n'),
    sources,
    offset: context ? Number(code.closest<HTMLElement>('[data-meo-code-offset]')?.dataset.meoCodeOffset ?? 0) : 0,
    version: String(getShikiThemeVersion('preview')) + (context ? ':' + context.id : '')
  };
}

/** Returns false only after scheduling tokens needed for an atomic visible update. */
export function isPreviewCodeHighlightReady(root: ParentNode, isCurrent: () => boolean = () => true): boolean {
  let ready = true;
  for (const code of root.querySelectorAll<HTMLElement>('code.hljs')) {
    const request = getHighlightRequest(code);
    if (!request || getShikiTokens(request.language, request.source, 'preview')) continue;
    requestShikiTokens(request.language, request.source, 'preview', isCurrent);
    ready = false;
  }
  return ready;
}

/** Whether a block has themed reading rows to preserve during an atomic update. */
export function hasAppliedPreviewCodeHighlight(root: ParentNode): boolean {
  const requests = Array.from(root.querySelectorAll<HTMLElement>('code.hljs'))
    .map(getHighlightRequest)
    .filter((request): request is NonNullable<ReturnType<typeof getHighlightRequest>> => request !== null);
  if (requests.length === 0) return false;
  return requests.every(request => request.sources.some(source => source.dataset.meoShiki === request.version));
}

/** Projects the exact Shiki tokens used by Live mode onto an already-rendered Preview code block. */
export function applyPreviewCodeHighlight(frameDocument: Document, nearViewportOnly = false, isCurrent: () => boolean = () => true): void {
  if (!isCurrent()) return;
  const nearby = nearViewportOnly ? getPreviewViewportResources(frameDocument, 'code') : undefined;
  const codes = nearby ?? Array.from(frameDocument.querySelectorAll<HTMLElement>('code.hljs'));
  const height = nearViewportOnly ? frameDocument.documentElement.clientHeight : 0;
  // Read the whole candidate band before token DOM writes can invalidate layout.
  const candidates = nearViewportOnly ? codes.filter(code => {
    const bounds = code.getBoundingClientRect();
    return bounds.bottom >= -height && bounds.top <= height * 2;
  }) : codes;
  const requests = candidates.flatMap(code => {
    const request = getHighlightRequest(code);
    if (!request) return [];
    const [from, to] = nearViewportOnly ? previewCodeReadingBand(request.sources, height) : [0, request.sources.length];
    return [{ ...request, from, to }];
  });
  for (const { language, source, sources, from, to, offset, version: themeVersion } of requests) {
    if (sources.slice(from, to).every((sourceElement) => sourceElement.dataset.meoShiki === themeVersion)) continue;
    const lines = getShikiTokens(language, source, 'preview');
    if (!lines) {
      requestShikiTokens(language, source, 'preview', isCurrent);
      continue;
    }

    // Retain the preceding bracket context, but allocate presentation runs only
    // for the reading band. A cached full-fence projection duplicates large
    // token arrays and erases much of the DOM reduction's memory benefit.
    const projectedLines = frameDocument.documentElement.dataset.meoPreviewBracketColoring === 'false'
      ? lines.slice(from + offset, to + offset) : projectShikiTokenLines(lines, getShikiThemeMeta('preview'), { from: from + offset, to: to + offset });
    for (let lineIndex = from; lineIndex < to; lineIndex++) {
      const sourceElement = sources[lineIndex]!;
      if (sourceElement.dataset.meoShiki === themeVersion) continue;
      const fragment = frameDocument.createDocumentFragment();
      for (const run of projectedLines[lineIndex - from] ?? []) {
        const span = frameDocument.createElement('span');
        applyTokenStyle(span, run);
        span.textContent = run.content;
        fragment.append(span);
      }
      // Keep blank rows selectable after replacing the server-rendered tokens.
      if (fragment.textContent === '' && (source.length > 0 || sourceElement.querySelector('br'))) {
        fragment.append(frameDocument.createElement('br'));
      }
      sourceElement.replaceChildren(fragment);
      sourceElement.dataset.meoShiki = themeVersion;
    }
  }
}
