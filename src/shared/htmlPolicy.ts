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

const cssLength = /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|%|ch))$/i;
const cssColor = /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\))$/i;
const cssKeywords: Readonly<Record<string, RegExp>> = {
  'text-align': /^(?:left|center|right|justify|start|end)$/i,
  'font-weight': /^(?:normal|bold|[1-9]00)$/i,
  'font-style': /^(?:normal|italic|oblique)$/i,
  'text-decoration': /^(?:none|underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*$/i,
  'white-space': /^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/i,
  'vertical-align': /^(?:baseline|sub|super|top|middle|bottom|text-top|text-bottom)$/i,
  display: /^(?:none|block|inline|inline-block)$/i,
  visibility: /^(?:visible|hidden|collapse)$/i,
  opacity: /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/
};

export const htmlInlineStyleRules: Record<string, RegExp[]> = {
  color: [cssColor],
  'background-color': [cssColor],
  background: [cssColor],
  ...Object.fromEntries(['width', 'height', 'max-width', 'max-height', 'min-width', 'min-height']
    .map(name => [name, [cssLength, /^(?:auto|none)$/i]])),
  'font-size': [cssLength],
  ...Object.fromEntries(Object.entries(cssKeywords).map(([name, rule]) => [name, [rule]]))
};

/** Document formatting only: no CSS URLs, selectors, positioning or editor chrome. */
export function inspectHtmlStyle(source: string): { style: string; unsupported: string[]; invalid: string[] } {
  const declarations = new Map<string, string>();
  const unsupported = new Set<string>(), invalid = new Set<string>();
  for (const declaration of source.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) {
      if (declaration.trim()) invalid.add(declaration.trim().split(/\s+/)[0]);
      continue;
    }
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    const rules = Object.hasOwn(htmlInlineStyleRules, name) ? htmlInlineStyleRules[name] : undefined;
    const valid = rules?.some(rule => rule.test(value)) === true;
    if (valid) declarations.set(name, value);
    else (rules ? invalid : unsupported).add(name);
  }
  return { style: [...declarations].map(([name, value]) => `${name}: ${value}`).join('; '),
    unsupported: [...unsupported], invalid: [...invalid] };
}

export function sanitizeHtmlStyle(source: string): string {
  return inspectHtmlStyle(source).style;
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
