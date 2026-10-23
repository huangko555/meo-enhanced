import { Parser, parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';
import { ChangeSet, Text } from '@codemirror/state';

export type HtmlFormatResult = {
  kind: 'formatted' | 'formatted-protected' | 'unchanged' | 'boundary' | 'unsafe' | 'invalid';
  source: string;
  offsets: number[];
};

function refineCursorOffset(source: string, formatted: string, offset: number, approximate: number): number {
  if (offset === 0) return 0;
  if (offset === source.length) return formatted.length;
  // HTML printers can place a text-boundary cursor just inside the preceding tag.
  // Retained nearby source text identifies the same editing boundary precisely.
  let best = approximate, matched = 0;
  for (let length = 32; length >= 4; length--) for (const before of [false, true]) {
    const fragment = before ? source.slice(Math.max(0, offset - length), offset) : source.slice(offset, offset + length);
    if (fragment.length < length) continue;
    const start = Math.max(0, approximate - 4 - (before ? length : 0));
    let found = formatted.indexOf(fragment, start);
    while (found >= 0) {
      const candidate = found + (before ? length : 0);
      if (candidate > approximate + 4) break;
      if (Math.abs(candidate - approximate) <= 4 && (length > matched || length === matched && Math.abs(candidate - approximate) < Math.abs(best - approximate))) {
        best = candidate; matched = length;
      }
      found = formatted.indexOf(fragment, found + 1);
    }
  }
  return Math.max(0, Math.min(formatted.length, best));
}

const blockTags = new Set('address article aside blockquote caption center dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul'.split(' '));
const element = (node: ChildNode) => 'attribs' in node && 'children' in node ? node : null;
const inlineOverride = (node: ChildNode) => /(?:^|;)\s*display\s*:\s*inline(?:-block)?\b/i.test(element(node)?.attribs.style ?? '');
const isBlock = (node: ChildNode) => !!element(node) && !inlineOverride(node) && blockTags.has(element(node)!.name);
const hasInlineNeighbor = (node: ChildNode, side: 'prev' | 'next'): boolean => {
  let neighbor = node[side];
  while (neighbor?.type === 'comment' || neighbor?.type === 'text' && !neighbor.data.trim()) neighbor = neighbor[side];
  return neighbor ? !isBlock(neighbor as ChildNode)
    : !!node.parent && node.parent.type !== 'root' && !isBlock(node.parent as ChildNode);
};

function tagSignature(source: string): string {
  const tags: string[] = [];
  new Parser({ onopentag(name, _attributes, implied) { if (!implied) tags.push(name); },
    onclosetag(name, implied) { if (!implied) tags.push('/' + name); } }).end(source);
  return JSON.stringify(tags);
}

function contentSignature(source: string): string {
  const tree = parseDocument(source);
  const visit = (node: ChildNode, preserve = false): unknown => {
    if (node.type === 'text') {
      let text = preserve ? node.data : node.data.replace(/[\t\n\f\r ]+/g, ' ');
      if (!preserve) {
        const parentBlock = !node.parent || node.parent.type === 'root' || isBlock(node.parent as ChildNode);
        if (node.prev ? isBlock(node.prev as ChildNode) : parentBlock) text = text.replace(/^ +/, '');
        if (node.next ? isBlock(node.next as ChildNode) : parentBlock) text = text.replace(/ +$/, '');
      }
      return text ? ['text', text] : null;
    }
    if (node.type === 'comment') return ['comment', node.data];
    if (!('attribs' in node) || !('children' in node)) return [node.type];
    const sensitive = preserve || /^(?:pre|code|textarea|script|style)$/.test(node.name)
      || /(?:^|;)\s*white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)\b/i.test(node.attribs.style ?? '');
    return [node.name, Object.entries(node.attribs).sort(([left], [right]) => left.localeCompare(right)),
      node.children.map(child => visit(child, sensitive)).filter(child => child !== null)];
  };
  return JSON.stringify(tree.children.map(node => visit(node)).filter(node => node !== null));
}

type Island = { from: number; to: number; inline: boolean; tag: string; marker?: string };

function protectedIslands(source: string): Island[] | null {
  const tree = parseDocument(source, { withStartIndices: true, withEndIndices: true });
  const ranges: Island[] = [];
  let valid = true;
  const visit = (node: ChildNode) => {
    const el = element(node);
    if (!el) return;
    const inline = inlineOverride(node);
    if (inline || /^(?:pre|code|textarea|script|style)$/.test(el.name)
      || /(?:^|;)\s*white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)\b/i.test(el.attribs.style ?? '')) {
      let from = el.startIndex, to = el.endIndex === null ? null : el.endIndex + 1;
      if (from === null || to === null || !source.slice(from, to).endsWith('>')) { valid = false; return; }
      const voidElement = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(el.name);
      if (!voidElement
        && !new RegExp(`</${el.name}\\s*>$`, 'i').test(source.slice(from, to))) { valid = false; return; }
      if (inline) {
        if (hasInlineNeighbor(node, 'prev')) from -= /[\t\n\f\r ]*$/.exec(source.slice(0, from))![0].length;
        if (hasInlineNeighbor(node, 'next')) to += /^[\t\n\f\r ]*/.exec(source.slice(to))![0].length;
      }
      ranges.push({ from, to, inline: inline || !isBlock(node), tag: inline || voidElement ? 'span' : el.name });
    } else el.children.forEach(visit);
  };
  tree.children.forEach(visit);
  const merged: Island[] = [];
  for (const range of ranges.sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && (range.from < last.to || range.from === last.to && last.inline && range.inline)) {
      last.to = Math.max(last.to, range.to);
      last.inline &&= range.inline;
      last.tag = last.inline ? 'span' : 'div';
    } else merged.push({ ...range });
  }
  return valid ? merged : null;
}

/** Protect raw islands only in the temporary printer input, then restore their exact source. */
export async function formatHtmlFragment(source: string, offsets: readonly number[], tabSize = 2): Promise<HtmlFormatResult> {
  const retain = (kind: 'boundary' | 'unsafe' | 'invalid'): HtmlFormatResult => ({ kind, source, offsets: [...offsets] });
  const islands = protectedIslands(source);
  if (!islands) return retain('boundary');
  let seed = 'MEO_PRESERVED_';
  while (source.includes(seed)) seed += '_';
  const masking = ChangeSet.of(islands.map((range, index) => {
    range.marker = seed + index;
    return { from: range.from, to: range.to, insert: `<${range.tag}>${range.marker}</${range.tag}>` };
  }), source.length);
  const masked = masking.apply(Text.of(source.split('\n'))).toString();
  const [prettier, html] = await Promise.all([import('prettier/standalone'), import('prettier/plugins/html')]);
  const options = { parser: 'html', plugins: [html], htmlWhitespaceSensitivity: 'css' as const,
    embeddedLanguageFormatting: 'off' as const, printWidth: 100, tabWidth: tabSize, endOfLine: 'auto' as const };
  const results = new Map<number, Awaited<ReturnType<typeof prettier.formatWithCursor>>>();
  for (const offset of new Set(offsets.length ? offsets : [0])) {
    const island = islands.find(range => offset >= range.from && offset <= range.to);
    results.set(offset, await prettier.formatWithCursor(masked, { ...options,
      cursorOffset: island ? masking.mapPos(island.from, -1) : masking.mapPos(offset, 1) }));
  }
  const first = results.values().next().value!;
  const printed = source.endsWith('\n') ? first.formatted : first.formatted.replace(/\r?\n$/, '');
  const restores = islands.map(range => {
    const at = printed.indexOf(range.marker!);
    const from = printed.lastIndexOf(`<${range.tag}>`, at), closing = `</${range.tag}>`;
    const to = printed.indexOf(closing, at) + closing.length;
    if (at < 0 || from < 0 || to < at || printed.slice(from + range.tag.length + 2, at).trim()
      || printed.slice(at + range.marker!.length, to - closing.length).trim()) return null;
    return { from, to, insert: source.slice(range.from, range.to) };
  });
  if (restores.some(range => !range)) return retain('boundary');
  const restoration = ChangeSet.of(restores as { from: number; to: number; insert: string }[], printed.length);
  const formatted = restoration.apply(Text.of(printed.split('\n'))).toString();
  if (tagSignature(source) !== tagSignature(formatted)) return retain('invalid');
  if (formatted.includes(seed) || contentSignature(source) !== contentSignature(formatted)) return retain('unsafe');
  return { kind: formatted === source ? 'unchanged' : islands.length ? 'formatted-protected' : 'formatted', source: formatted,
    offsets: offsets.map(offset => {
      const index = islands.findIndex(range => offset >= range.from && offset <= range.to);
      if (index >= 0) return restoration.mapPos(restores[index]!.from, -1) + offset - islands[index].from;
      return refineCursorOffset(source, formatted, offset, restoration.mapPos(Math.min(printed.length, results.get(offset)!.cursorOffset), 1));
    }) };
}
