import katex from 'katex';

export type SharedMathMode = 'inline' | 'display';

const MATH_RENDER_CACHE_LIMIT = 300;
const mathHtmlCache = new Map<string, string | null>();

function getCachedMathHtml(key: string): string | null | undefined {
  const cached = mathHtmlCache.get(key);
  if (cached === undefined) {
    return undefined;
  }
  mathHtmlCache.delete(key);
  mathHtmlCache.set(key, cached);
  return cached;
}

function cacheMathHtml(key: string, value: string | null): void {
  mathHtmlCache.delete(key);
  mathHtmlCache.set(key, value);
  if (mathHtmlCache.size <= MATH_RENDER_CACHE_LIMIT) {
    return;
  }
  const oldestKey = mathHtmlCache.keys().next().value;
  if (oldestKey !== undefined) {
    mathHtmlCache.delete(oldestKey);
  }
}

export function renderMathToHtml(content: string, mode: SharedMathMode): string | null {
  const normalized = String(content ?? '').trim();
  if (!normalized) {
    return null;
  }

  const cacheKey = `${mode}:${normalized}`;
  const cached = getCachedMathHtml(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const html = katex.renderToString(normalized, {
      displayMode: mode === 'display',
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'html',
      errorColor: 'inherit'
    });
    cacheMathHtml(cacheKey, html);
    return html;
  } catch (error: unknown) {
    console.warn('[MEO math] KaTeX render failed', {
      mode,
      message: String(error instanceof Error ? error.message : error),
      expression: normalized.slice(0, 160)
    });
    cacheMathHtml(cacheKey, null);
    return null;
  }
}
