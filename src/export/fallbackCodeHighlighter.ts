import hljs from 'highlight.js';

const POWER_QUERY_KEYWORDS =
  'let in each if then else try otherwise error and or not as is type meta section shared';
const POWER_QUERY_HASH_KEYWORDS =
  '#date #time #datetime #datetimezone #duration #table #binary #sections #shared';

// Only context-free fallback token HTML is retained. Source positions, wrappers,
// appearance, and document sanitization are recomputed on every render.
const FENCE_HIGHLIGHT_CACHE_ENTRIES = 256;
const FENCE_HIGHLIGHT_CACHE_BYTES = 8 * 1024 * 1024;
const FENCE_HIGHLIGHT_ENTRY_BYTES = 256 * 1024;
const fenceHighlightCache = new Map<string, string>();
let fenceHighlightCacheBytes = 0;

registerExportLanguages();

function registerExportLanguages(): void {
  if (hljs.getLanguage('powerquery')) {
    return;
  }

  hljs.registerLanguage('powerquery', () => ({
    name: 'PowerQuery',
    keywords: {
      keyword: POWER_QUERY_KEYWORDS,
      literal: 'true false null',
      built_in: POWER_QUERY_HASH_KEYWORDS
    },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.COMMENT(/\/\*/, /\*\//),
      {
        className: 'property',
        begin: /\[[^\]\r\n]+\]/
      },
      {
        className: 'variable',
        begin: /@[a-z_][a-z0-9_]*/i
      },
      {
        className: 'string',
        variants: [
          {
            begin: /#?"/,
            end: /(?<!")"(?!")/,
            contains: [{ begin: /""/ }]
          }
        ]
      },
      {
        className: 'number',
        begin: /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i
      }
    ]
  }));
}

export function highlightFence(code: string, language: string): string | undefined {
  if (language && hljs.getLanguage(language)) {
    // JSON owns an unambiguous key without retaining a slice of a larger document.
    const key = code.length * 2 <= FENCE_HIGHLIGHT_ENTRY_BYTES
      ? JSON.stringify([language, code])
      : null;
    const cached = key === null ? undefined : fenceHighlightCache.get(key);
    if (cached !== undefined && key !== null) {
      fenceHighlightCache.delete(key);
      fenceHighlightCache.set(key, cached);
      return cached;
    }
    try {
      const result = hljs.highlight(code, { language, ignoreIllegals: true });
      // A transient failure must be retried, including highlight.js safe-mode errors.
      if (key !== null && !result.errorRaised && !result.illegal) cacheFenceHighlight(key, result.value);
      return result.value;
    } catch {
      // Fallback to escaped plain text.
    }
  }
  return undefined;
}

function cacheFenceHighlight(key: string, html: string): void {
  const bytes = (key.length + html.length) * 2;
  if (bytes > FENCE_HIGHLIGHT_ENTRY_BYTES) return;
  // Bound UTF-16 text payload as well as entry count; a few large fences must not
  // pin arbitrarily large documents for the lifetime of the extension Host.
  while (fenceHighlightCache.size >= FENCE_HIGHLIGHT_CACHE_ENTRIES
    || fenceHighlightCacheBytes + bytes > FENCE_HIGHLIGHT_CACHE_BYTES) {
    const oldest = fenceHighlightCache.keys().next().value!;
    fenceHighlightCacheBytes -= (oldest.length + fenceHighlightCache.get(oldest)!.length) * 2;
    fenceHighlightCache.delete(oldest);
  }
  // Plain token HTML can still be a slice of MarkdownIt's complete source.
  // Detach it before retention so the payload limit also releases parent documents.
  fenceHighlightCache.set(key, JSON.parse(JSON.stringify(html)) as string);
  fenceHighlightCacheBytes += bytes;
}
