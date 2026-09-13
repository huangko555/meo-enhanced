import {
  getShikiThemeMeta,
  getShikiTokens,
  getShikiThemeVersion,
  requestShikiTokens,
  resolveShikiLang,
  type ShikiToken
} from './shikiHighlighter';

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

function applyTokenStyle(element: HTMLElement, syntaxToken: ShikiToken, color?: string): void {
  // Shiki has already resolved the active VS Code TextMate theme at token
  // scope precision. Reclassifying it here loses theme-specific distinctions.
  element.style.color = color ?? syntaxToken.color ?? 'var(--meo-code-fg)';
  const fontStyle = syntaxToken.fontStyle ?? 0;
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
export function isPreviewCodeHighlightReady(root: ParentNode): boolean {
  let ready = true;
  for (const code of root.querySelectorAll<HTMLElement>('code.hljs')) {
    const request = getHighlightRequest(code);
    if (!request || getShikiTokens(request.language, request.source, 'preview')) continue;
    requestShikiTokens(request.language, request.source, 'preview');
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
export function applyPreviewCodeHighlight(frameDocument: Document, nearViewportOnly = false): void {
  const themeVersion = String(getShikiThemeVersion('preview'));
  for (const code of frameDocument.querySelectorAll<HTMLElement>('code.hljs')) {
    if (nearViewportOnly) {
      const height = frameDocument.documentElement.clientHeight;
      const bounds = code.getBoundingClientRect();
      // Inspect geometry before extracting source or allocating token DOM.
      if (bounds.bottom < -height || bounds.top > height * 2) continue;
    }
    const request = getHighlightRequest(code);
    if (!request) continue;
    const { language, source, sources } = request;
    if (sources.every((sourceElement) => sourceElement.dataset.meoShiki === themeVersion)) continue;
    const lines = getShikiTokens(language, source, 'preview');
    if (!lines) {
      requestShikiTokens(language, source, 'preview');
      continue;
    }

    const meta = getShikiThemeMeta('preview');
    let bracketDepth = 0;
    for (const [lineIndex, sourceElement] of sources.entries()) {
      const fragment = frameDocument.createDocumentFragment();
      for (const syntaxToken of lines[lineIndex] ?? []) {
        let runStart = 0;
        for (let index = 0; index < syntaxToken.content.length; index += 1) {
          const character = syntaxToken.content[index];
          const opening = character === '(' || character === '[' || character === '{';
          const closing = character === ')' || character === ']' || character === '}';
          if ((!opening && !closing) || syntaxToken.isStringComment) continue;
          if (index > runStart) {
            const span = frameDocument.createElement('span');
            applyTokenStyle(span, syntaxToken);
            span.textContent = syntaxToken.content.slice(runStart, index);
            fragment.append(span);
          }
          const bracket = frameDocument.createElement('span');
          let bracketColor = meta.unexpectedBracket;
          if (opening) {
            bracketColor = meta.bracketColors[bracketDepth % meta.bracketColors.length] ?? syntaxToken.color;
            bracketDepth += 1;
          } else if (bracketDepth > 0) {
            bracketDepth -= 1;
            bracketColor = meta.bracketColors[bracketDepth % meta.bracketColors.length] ?? syntaxToken.color;
          }
          applyTokenStyle(bracket, syntaxToken, bracketColor);
          bracket.textContent = character;
          fragment.append(bracket);
          runStart = index + 1;
        }
        if (runStart < syntaxToken.content.length) {
          const span = frameDocument.createElement('span');
          applyTokenStyle(span, syntaxToken);
          span.textContent = syntaxToken.content.slice(runStart);
          fragment.append(span);
        }
      }
      sourceElement.replaceChildren(fragment);
      sourceElement.dataset.meoShiki = themeVersion;
    }
  }
}
