export const supportedHtmlTags = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'details',
  'div',
  'em',
  'i',
  'img',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  's',
  'span',
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
  'blockquote',
  'details',
  'div',
  'ol',
  'p',
  'table',
  'ul'
]);

const globalAttributes = new Set(['id', 'title']);
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
  if (normalizedAttribute.startsWith('on') || normalizedAttribute === 'style') {
    return false;
  }
  return globalAttributes.has(normalizedAttribute) ||
    attributesByTag[tagName.toLowerCase()]?.has(normalizedAttribute) === true;
}

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

export interface HtmlTagToken {
  from: number;
  to: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

export function scanHtmlTags(source: string): HtmlTagToken[] {
  const tags: HtmlTagToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const from = source.indexOf('<', cursor);
    if (from < 0) break;

    let quote: '"' | "'" | null = null;
    let to = -1;
    for (let index = from + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        to = index + 1;
        break;
      }
    }
    if (to < 0) break;

    const rawTag = source.slice(from, to);
    const match = /^<\s*(\/?)\s*([a-z][a-z\d-]*)\b/i.exec(rawTag);
    if (!match) {
      cursor = from + 1;
      continue;
    }
    tags.push({
      from,
      to,
      name: match[2].toLowerCase(),
      closing: match[1] === '/',
      selfClosing: /\/\s*>$/.test(rawTag)
    });
    cursor = to;
  }
  return tags;
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
