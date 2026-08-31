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

/** Projects the exact Shiki tokens used by Live mode onto an already-rendered Preview code block. */
export function applyPreviewCodeHighlight(frameDocument: Document): void {
  const themeVersion = String(getShikiThemeVersion('preview'));
  for (const code of frameDocument.querySelectorAll<HTMLElement>('code.hljs')) {
    const languageClass = Array.from(code.classList).find((name) => name.startsWith('language-'));
    const language = resolveShikiLang(languageClass?.slice('language-'.length));
    if (!language) continue;
    const sources = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-source'));
    if (sources.length === 0) continue;
    if (sources.every((sourceElement) => sourceElement.dataset.meoShiki === themeVersion)) continue;
    const source = sources.map((line) => line.textContent ?? '').join('\n');
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
