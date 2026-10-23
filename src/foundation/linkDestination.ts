/** Normalize authored link targets without decoding filename escapes or fragments. */
export function normalizeLinkDestination(destination: string): string {
  let href = destination.trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim();
  // Drive letters are filesystem roots, not URL schemes. Both Markdown renderers
  // and Host navigation consume the same file URI, including encoded separators.
  if (/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(href)) {
    const suffixAt = href.search(/[?#]/);
    const path = suffixAt < 0 ? href : href.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? '' : href.slice(suffixAt);
    return 'file:///' + path.replace(/\\|%5c|%2f/gi, '/').replace(/ /g, '%20') + suffix;
  }
  return href;
}

export function isLocalFileLinkDestination(destination: string): boolean {
  return /^file:/i.test(normalizeLinkDestination(destination));
}

/** The same authored target must be local for both navigation and missing-link hints. */
export function isLikelyLocalLinkDestination(destination: string): boolean {
  const href = normalizeLinkDestination(destination);
  if (!href || href.startsWith('#') || href.startsWith('//')) return false;
  if (/^file:/i.test(href)) return true;
  const rawPath = href.split(/[?#]/, 1)[0];
  if (!rawPath) return false;
  let path = rawPath;
  try { path = decodeURIComponent(path); } catch { /* Keep malformed escapes literal. */ }
  path = path.replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(path)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath)) return false;
  if (/^(?:\.\.?\/|\/|~)/.test(path)) return true;
  if (/^www\./i.test(path)) return false;
  if (/\.(?:md|markdown|mdx|mdc)$/i.test(path)) return true;
  const host = path.split('/', 1)[0].split(':', 1)[0];
  return host !== 'localhost' && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host);
}

/**
 * Serialize a raw filesystem path for a Markdown destination. Keep Unicode
 * readable; escape syntax and URI delimiters so filenames retain their identity.
 * The input must be a filesystem path, never an already encoded URL.
 */
export function encodeMarkdownPath(path: string): string {
  const windowsDrive = /^[a-z]:[\\/]/i.test(path);
  return path.replace(/[\s\u0000-\u001f\u007f-\u009f%()[\]<>#?&:\\|"'`]/gu, (character, offset: number) => {
    if (character === ':' && offset === 1 && windowsDrive) return character;
    const code = character.charCodeAt(0);
    return code <= 0x7f ? '%' + code.toString(16).toUpperCase().padStart(2, '0') : encodeURIComponent(character);
  });
}

/** Display only: decode once, retaining URI delimiters and malformed escapes. */
export function formatLinkDestination(destination: string): string {
  // Decode one UTF-8 character at a time so invalid bytes cannot hide adjacent
  // valid Chinese, and an escaped percent sign is never decoded a second time.
  return destination.replace(/%(?:[0-7][0-9a-f]|[cd][0-9a-f]%[89ab][0-9a-f]|e[0-9a-f](?:%[89ab][0-9a-f]){2}|f[0-4](?:%[89ab][0-9a-f]){3})/gi, encoded => {
    try { return decodeURI(encoded); }
    catch { return encoded; }
  });
}
