import {
  getShikiThemeMeta,
  getShikiTokens,
  getShikiThemeVersion,
  requestShikiTokens,
  resolveShikiLang
} from './shikiHighlighter';
import { projectShikiTokenLines, type ShikiPresentationRun } from '../../../src/shared/shikiTokenPresentation';

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

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
} | null {
  const languageClass = Array.from(code.classList).find((name) => name.startsWith('language-'));
  const language = resolveShikiLang(languageClass?.slice('language-'.length));
  if (!language) return null;
  const sources = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-source'));
  if (sources.length === 0) return null;
  return {
    language,
    source: sources.map((line) => line.textContent ?? '').join('\n'),
    sources
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

/** Whether a currently visible block has already received its Shiki token DOM. */
export function hasAppliedPreviewCodeHighlight(root: ParentNode): boolean {
  const requests = Array.from(root.querySelectorAll<HTMLElement>('code.hljs'))
    .map(getHighlightRequest)
    .filter((request): request is NonNullable<ReturnType<typeof getHighlightRequest>> => request !== null);
  if (requests.length === 0) return false;
  const themeVersion = String(getShikiThemeVersion('preview'));
  return requests.every(request => request.sources.every(source => source.dataset.meoShiki === themeVersion));
}

/** Projects the exact Shiki tokens used by Live mode onto an already-rendered Preview code block. */
export function applyPreviewCodeHighlight(frameDocument: Document, nearViewportOnly = false, isCurrent: () => boolean = () => true): void {
  const themeVersion = String(getShikiThemeVersion('preview'));
  const codes = Array.from(frameDocument.querySelectorAll<HTMLElement>('code.hljs'));
  const height = nearViewportOnly ? frameDocument.documentElement.clientHeight : 0;
  // Read the whole candidate band before token DOM writes can invalidate layout.
  const candidates = nearViewportOnly ? codes.filter(code => {
    const bounds = code.getBoundingClientRect();
    return bounds.bottom >= -height && bounds.top <= height * 2;
  }) : codes;
  for (const code of candidates) {
    const request = getHighlightRequest(code);
    if (!request) continue;
    const { language, source, sources } = request;
    if (sources.every((sourceElement) => sourceElement.dataset.meoShiki === themeVersion)) continue;
    const lines = getShikiTokens(language, source, 'preview');
    if (!lines) {
      requestShikiTokens(language, source, 'preview', isCurrent);
      continue;
    }

    const projectedLines = projectShikiTokenLines(lines, getShikiThemeMeta('preview'));
    for (const [lineIndex, sourceElement] of sources.entries()) {
      const fragment = frameDocument.createDocumentFragment();
      for (const run of projectedLines[lineIndex] ?? []) {
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
