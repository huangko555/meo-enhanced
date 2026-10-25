import type MarkdownIt from 'markdown-it';
import { DomUtils, parseDocument } from 'htmlparser2';
import { isTag, isText, type Element } from 'domhandler';
import type { MarkdownTokenBlock } from './markdownPresentationBlocks';

type SyntaxNode = ReturnType<MarkdownIt['parse']>[number];
type ContainerBand = MarkdownTokenBlock & { container: { open: number; close: number; offset: number; first: boolean; last: boolean } };
export const isMarkdownContainerBand = (block: MarkdownTokenBlock): block is ContainerBand => 'container' in block;

/** Split only complete list items or ordinary quote paragraphs; nested children
 * and raw HTML keep their own semantics, including the list's tight/loose mode. */
export function splitMarkdownContainerBands(nodes: readonly SyntaxNode[], blocks: readonly MarkdownTokenBlock[], sourceLines: readonly number[]): MarkdownTokenBlock[] {
  const result: MarkdownTokenBlock[] = [];
  for (const block of blocks) {
    const open = nodes[block.from]!, quote = open.type === 'blockquote_open';
    if (!/^(bullet_list|ordered_list|blockquote)_open$/.test(open.type)
      || nodes[block.to - 1]?.type !== open.type.replace('_open', '_close')) {
      result.push({ ...block, index: result.length }); continue;
    }
    const children: { from: number; to: number }[] = [];
    let depth = 0, start = block.from + 1, safe = true;
    for (let index = start; index < block.to - 1; index++) {
      const node = nodes[index]!;
      if (node.type === 'html_block' || node.children?.some(child => child.type === 'html_inline')
        || node.type === 'inline' && /<\/?[a-z!]/i.test(node.content)) safe = false;
      depth += node.nesting;
      if (depth === 0) { children.push({ from: start, to: index + 1 }); start = index + 1; }
    }
    if (!safe || children.length < 256 || children.some(child => nodes[child.from]!.type !== (quote ? 'paragraph_open' : 'list_item_open'))
      || quote && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(nodes[children[0]!.from + 1]?.content ?? '')) {
      result.push({ ...block, index: result.length }); continue;
    }
    for (let offset = 0; offset < children.length; offset += 32) {
      const part = children.slice(offset, offset + 32), from = part[0]!.from, to = part.at(-1)!.to;
      const first = offset === 0, last = offset + part.length === children.length;
      const firstMap = nodes[from]!.map!, lastMap = nodes[part.at(-1)!.from]!.map!;
      result.push({ index: result.length, from, to, kind: block.kind + '_band',
        sourceLine: first ? block.sourceLine : sourceLines[firstMap[0]] ?? firstMap[0] + 1,
        sourceEndLine: last ? block.sourceEndLine : sourceLines[lastMap[1] - 1] ?? lastMap[1],
        sourceCharacters: nodes.slice(from, to).reduce((sum, node) => sum + node.content.length, 0),
        container: { open: block.from, close: block.to - 1, offset, first, last }
      } as ContainerBand);
    }
  }
  return result;
}

export function renderContainerBandTokens(nodes: readonly SyntaxNode[], block: ContainerBand): SyntaxNode[] {
  const clone = (index: number) => {
    const original = nodes[index]!;
    const node = Object.assign(Object.create(Object.getPrototypeOf(original)), original) as SyntaxNode;
    node.attrs = original.attrs?.map(([name, value]) => [name, value]) ?? [];
    return node;
  };
  const band = block.container, open = clone(band.open), close = clone(band.close);
  open.attrSet('data-source-line', String(block.sourceLine)); open.attrSet('data-source-end-line', String(block.sourceEndLine));
  open.attrSet('data-meo-container-origin', String(band.open));
  open.attrSet('data-meo-container-part', band.first ? 'start' : band.last ? 'end' : 'middle');
  if (open.type === 'ordered_list_open') open.attrSet('start', String(Number(open.attrGet('start') ?? 1) + band.offset));
  open.block = band.first; close.block = band.last;
  return [open, ...nodes.slice(block.from, block.to), close];
}

export function joinPreviewContainerBands(html: string): string {
  if (!html.includes('data-meo-container-part=')) return html;
  const document = parseDocument(html);
  let previous: Element | undefined;
  for (const node of [...document.children]) {
    if (isText(node) && !node.data.trim()) continue;
    const part = isTag(node) ? node.attribs['data-meo-container-part'] : undefined;
    if (!isTag(node) || !part) { previous = undefined; continue; }
    if (previous && previous.name === node.name && part !== 'start'
      && previous.attribs['data-meo-container-part'] !== 'end'
      && previous.attribs['data-meo-container-origin'] === node.attribs['data-meo-container-origin']) {
      for (const child of [...node.children]) DomUtils.appendChild(previous, child);
      previous.attribs['data-meo-container-part'] = part;
      previous.attribs['data-source-end-line'] = node.attribs['data-source-end-line']!;
      DomUtils.removeElement(node);
    } else previous = node;
  }
  for (const node of DomUtils.findAll(node => !!node.attribs['data-meo-container-part'], document.children)) {
    delete node.attribs['data-meo-container-part']; delete node.attribs['data-meo-container-origin'];
  }
  return DomUtils.getOuterHTML(document.children);
}
