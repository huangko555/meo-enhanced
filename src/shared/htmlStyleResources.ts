import { parse, type Container } from 'postcss';

/** CSS resources follow the stylesheet that contains the reference. The IO
 * adapter owns URI resolution, access policy and asset delivery. */
export type HtmlStyleResources = {
  read(url: string): Promise<{ css: string; url: string }>;
  resolve(url: string, base?: string): string;
  asset(url: string): Promise<string>;
  signal?: AbortSignal;
};

export function isSafeHtmlStyleUrl(value: string): boolean {
  const url = value.trim();
  if (!url || /[\u0000-\u001f\u007f\\<>]/.test(url)) return false;
  if (/^data:/i.test(url)) return /^data:(?:image\/(?:png|gif|jpe?g|webp|avif|bmp|svg\+xml)|font\/[\w.+-]+|application\/(?:font-woff|vnd.ms-fontobject|octet-stream)|text\/css)[;,]/i.test(url);
  return !/^[a-z][\w+.-]*:/i.test(url) || /^(?:https:|file:)/i.test(url);
}

/** Parses quoted CSS URLs without matching literal strings or comments. CSS
 * escapes are rejected by the author policy before reaching this owner. */
export function mapHtmlStyleUrls(value: string, rewrite: (url: string) => string): string {
  return value.replace(/("[^"\\]*"|'[^'\\]*')|\burl\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^\s)'"\\]*))\s*\)/gi,
    (match, literal: string | undefined, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      if (literal) return literal;
      const mapped = rewrite(double ?? single ?? bare ?? '');
      return `url(${JSON.stringify(mapped).replace(/</g, '\\3c ')})`;
    });
}

export function htmlStyleHasResources(css: string): boolean {
  return /@meo-import\b|\burl\s*\(/i.test(css);
}

export function withoutHtmlStyleResources(css: string): string {
  try {
    const sheet = parse(css);
    sheet.walkAtRules('meo-import', rule => { rule.remove(); });
    sheet.walkDecls(declaration => {
      let external = false;
      mapHtmlStyleUrls(declaration.value, url => { external ||= !url.startsWith('#'); return url; });
      if (external) declaration.remove();
    });
    sheet.walkAtRules('font-face', rule => {
      if (!rule.nodes?.some(node => node.type === 'decl' && node.prop === 'src')) rule.remove();
    });
    return sheet.toString();
  } catch { return ''; }
}

export function htmlFontFaceName(family: string): string {
  const name = family.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < name.length; index++) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  return `meo-html-font-${(hash >>> 0).toString(16)}`;
}

export function namespaceHtmlFontFamilies(value: string): string {
  if (/meo-html-font-/.test(value) || /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(value)) return value;
  const families: string[] = [];
  let start = 0, depth = 0, quote = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { families.push(value.slice(start,index)); start = index+1; }
  }
  families.push(value.slice(start));
  return families.map(family => {
    const name = family.trim();
    const variable = /^var\(\s*(--[\w-]+)\s*,([\s\S]+)\)$/.exec(name);
    if (variable) return `var(${variable[1]}, ${namespaceHtmlFontFamilies(variable[2]!)})`;
    if (/^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i.test(name) || /\bvar\(/i.test(name)) return name;
    return `"${htmlFontFaceName(name)}", ${name}`;
  }).join(', ');
}

export function namespaceHtmlFontVariables(sheet: Container): void {
  const variables = new Set<string>();
  const definitions = new Map<string, import('postcss').Declaration[]>();
  sheet.walkDecls(declaration => {
    if (!declaration.prop.startsWith('--')) return;
    const entries = definitions.get(declaration.prop) ?? [];
    entries.push(declaration); definitions.set(declaration.prop,entries);
  });
  sheet.walkDecls(/^font-family$/i, declaration => {
    for (const match of declaration.value.matchAll(/\bvar\(\s*(--[\w-]+)/g)) variables.add(match[1]!);
  });
  for (const variable of variables) for (const declaration of definitions.get(variable) ?? []) {
    for (const match of declaration.value.matchAll(/\bvar\(\s*(--[\w-]+)/g)) variables.add(match[1]!);
    declaration.value = namespaceHtmlFontFamilies(declaration.value);
  }
}

function wrapImportedStyles(css: string, conditions = ''): string {
  let remaining = conditions.trim();
  let layer: string | undefined, supports: string | undefined;
  if (/^layer\b/i.test(remaining)) {
    const match = /^layer(?:\(([^()]*)\))?(?:\s+|$)/i.exec(remaining);
    if (!match) return '';
    layer = match[1] ?? '';
    remaining = remaining.slice(match[0].length).trim();
  }
  if (/^supports\(/i.test(remaining)) {
    let depth = 1, end = 'supports('.length;
    for (; end < remaining.length && depth; end++) {
      if (remaining[end] === '(') depth++;
      if (remaining[end] === ')') depth--;
    }
    if (depth) return '';
    supports = remaining.slice('supports('.length, end - 1);
    remaining = remaining.slice(end).trim();
  }
  let result = remaining ? `@media ${remaining}{${css}}` : css;
  if (supports !== undefined) result = `@supports (${supports}){${result}}`;
  if (layer !== undefined) result = `@layer ${layer}{${result}}`;
  return result;
}

export async function resolveHtmlStyleResources(css: string, resources: HtmlStyleResources, base?: string): Promise<string> {
  const loaded = new Map<string, Promise<{ css: string; url: string }>>();
  const assets = new Map<string, Promise<string>>();
  const expand = async (source: string, from: string | undefined, ancestors: ReadonlySet<string>): Promise<string> => {
    resources.signal?.throwIfAborted();
    const sheet = parse(source);
    const visit = async (container: Container): Promise<void> => {
      for (const node of [...(container.nodes ?? [])]) {
        resources.signal?.throwIfAborted();
        if (node.type === 'atrule' && node.name === 'meo-import') {
          const match = /^("[^"\\]*"|'[^'\\]*')(?:\s+([\s\S]*))?$/.exec(node.params);
          if (!match) { node.remove(); continue; }
          const raw = match[1]!.slice(1, -1);
          if (!isSafeHtmlStyleUrl(raw)) { node.remove(); continue; }
          const url = resources.resolve(raw, from);
          if (ancestors.has(url) || ancestors.size >= 32) { node.remove(); continue; }
          try {
            let request = loaded.get(url);
            if (!request) { request = resources.read(url); loaded.set(url, request); }
            const result = await request;
            const expanded = await expand(result.css, result.url, new Set([...ancestors, url]));
            node.replaceWith(parse(wrapImportedStyles(expanded, match[2])).nodes);
          } catch (error) {
            resources.signal?.throwIfAborted();
            node.remove();
          }
        } else if (node.type === 'decl' && /\burl\s*\(/i.test(node.value)) {
          const urls = new Map<string, string>();
          mapHtmlStyleUrls(node.value, raw => { urls.set(raw, ''); return raw; });
          await Promise.all([...urls.keys()].map(async raw => {
            const target = raw.trim();
            if (!isSafeHtmlStyleUrl(target)) return;
            if (target.startsWith('#')) { urls.set(raw, target); return; }
            // Like images, // stays on the network; a local stylesheet base would make it a file address.
            const url = resources.resolve(target.startsWith('//') ? `https:${target}` : target, from);
            let request = assets.get(url);
            if (!request) { request = resources.asset(url).catch(() => ''); assets.set(url, request); }
            urls.set(raw, await request);
          }));
          node.value = mapHtmlStyleUrls(node.value, raw => urls.get(raw) ?? '');
        } else if ('nodes' in node) await visit(node as Container);
      }
    };
    await visit(sheet);
    return sheet.toString();
  };
  const sheet = parse(await expand(css, base, new Set()));
  namespaceHtmlFontVariables(sheet);
  return sheet.toString();
}
