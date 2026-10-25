import { scanHtmlTags } from '../foundation/htmlSyntax';

export const supportedHtmlTags = new Set([
  'a',
  'abbr',
  'article',
  'b',
  'blockquote',
  'br',
  'code',
  'caption',
  'col',
  'colgroup',
  'del',
  'dl',
  'dt',
  'dd',
  'details',
  'div',
  'em',
  'figure',
  'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr',
  'i',
  'img',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  'ruby', 'rt', 'rp',
  's',
  'span',
  'section',
  'small',
  'strong',
  'summary',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul'
]);

export const supportedHtmlBlockTags = new Set([
  'dl',
  'article',
  'blockquote',
  'details',
  'div',
  'figure',
  'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr',
  'img',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul'
]);

const globalAttributes = new Set(['id', 'title', 'style', 'hidden', 'lang', 'dir']);
const attributesByTag: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'name', 'title']),
  details: new Set(['open']),
  div: new Set(['align']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  li: new Set(['value']),
  ol: new Set(['start', 'reversed']),
  p: new Set(['align']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope'])
};

export function isSupportedHtmlAttribute(tagName: string, attributeName: string): boolean {
  const normalizedAttribute = attributeName.toLowerCase();
  if (normalizedAttribute.startsWith('on')) {
    return false;
  }
  return globalAttributes.has(normalizedAttribute) ||
    attributesByTag[tagName.toLowerCase()]?.has(normalizedAttribute) === true;
}

export { inspectHtmlStyle, sanitizeHtmlStyle, htmlSanitizedStyleRules } from './htmlStyle';
export type { HtmlStyleInspection } from './htmlStyle';

export function getSupportedHtmlAttributes(tagName: string): string[] {
  return [...globalAttributes, ...(attributesByTag[tagName.toLowerCase()] ?? [])];
}

export function normalizeHtmlAlign(value: string | null): 'left' | 'center' | 'right' | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'left' || normalized === 'center' || normalized === 'right'
    ? normalized
    : null;
}

export function isSafeHtmlUrl(value: string, kind: 'href' | 'src'): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized.startsWith('#')) return kind === 'href';
  if (normalized.startsWith('//')) return false;
  if (/^(?:\.\.?\/|\/)/.test(normalized)) return true;

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  if (!scheme) return true;
  if (kind === 'href') {
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ||
      scheme === 'tel' || scheme === 'file';
  }
  return scheme === 'http' || scheme === 'https' || scheme === 'file' ||
    (scheme === 'data' && /^data:image\/(?:png|gif|jpe?g|webp|svg\+xml);/i.test(normalized));
}

/** A paired HTML code element owns its Markdown characters as literal content. */
export function matchInlineHtmlCode(source: string, from: number, end = source.length): {
  from: number; contentFrom: number; contentTo: number; to: number;
} | null {
  if (source.slice(from, from + 5).toLowerCase() !== '<code') return null;
  const text = source.slice(from, end);
  const open = /^<code(?:\s+[a-zA-Z:_][\w-.:]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>/i.exec(text);
  if (!open) return null;
  const closing = /<\/code\s*>/i.exec(text.slice(open[0].length));
  if (!closing) return null;
  const contentFrom = from + open[0].length;
  const contentTo = contentFrom + closing.index;
  return { from, contentFrom, contentTo, to: contentTo + closing[0].length };
}

export function getHtmlTagNames(source: string): string[] {
  return scanHtmlTags(source).map((tag) => tag.name);
}

export function isSupportedHtmlSource(source: string): boolean {
  if (/<!--[\s\S]*?-->|<!doctype\b|<\?/i.test(source)) return false;
  const names = getHtmlTagNames(source);
  return names.length > 0 && names.every((name) => supportedHtmlTags.has(name));
}

export function getHtmlRootTagName(source: string): string | null {
  return /^\s*<\s*([a-z][a-z\d-]*)\b/i.exec(source)?.[1]?.toLowerCase() ?? null;
}

export function isSupportedHtmlBlockSource(source: string): boolean {
  const root = getHtmlRootTagName(source);
  return root !== null && supportedHtmlBlockTags.has(root) && isSupportedHtmlSource(source);
}
