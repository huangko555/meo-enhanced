import type MarkdownIt from 'markdown-it';
import { Parser, parseDocument, DomUtils } from 'htmlparser2';
import { isTag, isText, type Element } from 'domhandler';
import type { MarkdownTokenBlock } from './markdownPresentationBlocks';

type MarkdownNode = ReturnType<MarkdownIt['parse']>[number];
export type MarkdownTableBand = MarkdownTokenBlock & Readonly<{
  table: { open: number; headEnd: number; bodyOpen: number; bodyClose: number; close: number;
    first: boolean; last: boolean; widths: readonly number[] };
}>;
export const isMarkdownTableBand = (block: MarkdownTokenBlock): block is MarkdownTableBand => 'table' in block;
const ROWS_PER_BAND = 32;

/** Top-level Markdown tables alone have independent rows. HTML containers and
 * nested tables keep their complete renderer; exports always use original tokens. */
export function tableRowRanges(tokens: readonly MarkdownNode[], from: number, to: number) {
  if (tokens[from]?.type !== 'table_open' || tokens[to - 1]?.type !== 'table_close') return null;
  let bodyOpen = from + 1;
  while (bodyOpen < to && tokens[bodyOpen]?.type !== 'tbody_open') bodyOpen++;
  if (bodyOpen === to) return null;
  if (bodyOpen < 0) return null;
  const rows: Array<{ from: number; to: number }> = [];
  let start = -1, columns = 0;
  for (let index = bodyOpen + 1; index < to; index++) {
    const node = tokens[index]!;
    if (node.type === 'tr_open') start = index;
    if (node.type === 'th_open' || node.type === 'td_open') columns++;
    if (node.type === 'tr_close' && start >= 0) { rows.push({ from: start, to: index + 1 }); start = -1; }
    if (node.type === 'tbody_close') {
      if (rows.length < 512 || columns < 1024) return null;
      return { bodyOpen, bodyClose: index, rows };
    }
  }
  return null;
}

/** Share whole-table column preferences, rather than sizing each visible band
 * from its own rows. Units follow body typography and survive width/font changes. */
function columnPreferences(tokens: readonly MarkdownNode[], from: number, to: number): number[] {
  const widths: number[] = [];
  let column = 0;
  for (let index = from; index < to; index++) {
    const node = tokens[index]!;
    if (node.type === 'tr_open') column = 0;
    else if (node.type === 'inline' && /^(?:td|th)_open$/.test(tokens[index - 1]?.type ?? '')) {
      const text = node.content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(?:\*\*|__|~~|==|`)/g, '');
      let width = 0, maximum = 0;
      for (const character of text) {
        if (character === '\n') { maximum = Math.max(maximum, width); width = 0; }
        else width += /[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60]/u.test(character) ? 1 : .58;
      }
      widths[column] = Math.max(widths[column] ?? 0, maximum, width); column++;
    }
  }
  return widths.map(width => Math.round(width * 100) / 100);
}

export function splitMarkdownTableBands(tokens: readonly MarkdownNode[], blocks: readonly MarkdownTokenBlock[], sourceLines: readonly number[]): Array<MarkdownTokenBlock | MarkdownTableBand> {
  const result: Array<MarkdownTokenBlock | MarkdownTableBand> = [];
  for (const block of blocks) {
    const table = tableRowRanges(tokens, block.from, block.to);
    // Raw inline containers may span cells/rows. Do not separate such markup.
    let depth = 0, crossesRow = false, unsafeTableMarkup = false;
    if (table) {
      const parser = new Parser({ onopentag: () => { depth++; }, onclosetag: () => { depth--; } });
      for (let index = block.from; index < block.to; index++) {
        const node = tokens[index]!;
        for (const child of node.children ?? []) if (child.type === 'html_inline' && !child.meta?.meoTrustedHtml) {
          unsafeTableMarkup ||= /<\/?(?:table|tr|td|th|thead|tbody|tfoot|caption|colgroup|col)\b/i.test(child.content);
          parser.write(child.content);
        }
        if (node.type === 'tr_close' && depth !== 0) crossesRow = true;
      }
      parser.end();
    }
    if (!table || crossesRow || unsafeTableMarkup) { result.push({ ...block, index: result.length }); continue; }
    const widths = columnPreferences(tokens, block.from, block.to);
    for (let offset = 0; offset < table.rows.length; offset += ROWS_PER_BAND) {
      const rows = table.rows.slice(offset, offset + ROWS_PER_BAND);
      const first = offset === 0, last = offset + ROWS_PER_BAND >= table.rows.length;
      const from = rows[0]!.from, to = rows.at(-1)!.to;
      const line = tokens[from]!.map!, end = tokens[rows.at(-1)!.from]!.map!;
      result.push({ index: result.length, kind: 'table_open', from, to,
        sourceLine: first ? block.sourceLine : sourceLines[line[0]] ?? line[0] + 1,
        sourceEndLine: sourceLines[end[1] - 1] ?? end[1],
        sourceCharacters: tokens.slice(first ? block.from : from, to).reduce((sum, token) => sum + token.content.length, 0),
        table: { open: block.from, headEnd: table.bodyOpen, bodyOpen: table.bodyOpen,
          bodyClose: table.bodyClose, close: block.to - 1, first, last, widths } });
    }
  }
  return result;
}

export function renderTableBandTokens(tokens: readonly MarkdownNode[], band: MarkdownTableBand): MarkdownNode[] {
  const table = band.table;
  const open = Object.assign(Object.create(Object.getPrototypeOf(tokens[table.open])), tokens[table.open]) as MarkdownNode;
  open.attrs = tokens[table.open]!.attrs?.map(([name, value]) => [name, value]) ?? [];
  open.attrSet('data-source-line', String(band.sourceLine));
  open.attrSet('data-source-end-line', String(band.sourceEndLine));
  open.attrSet('data-meo-preview-table-widths', table.widths.join(','));
  open.attrSet('data-meo-preview-table-origin', tokens[table.open]!.attrGet('data-source-line')!);
  open.attrSet('data-meo-preview-table-part', table.first ? 'start' : table.last ? 'end' : 'middle');
  return [open, ...(table.first ? tokens.slice(table.open + 1, table.headEnd) : []), tokens[table.bodyOpen]!,
    ...tokens.slice(band.from, band.to), tokens[table.bodyClose]!, tokens[table.close]!];
}

/** A clipboard selection is a document value, independent of its reading bands. */
export function joinPreviewTableBands(html: string): string {
  if (!html.includes('data-meo-preview-table-part=')) return html;
  const root = parseDocument(html);
  let previous: Element | undefined;
  for (const node of [...root.children]) {
    if (isText(node) && !node.data.trim()) continue;
    const table = isTag(node) && node.name === 'div' && node.attribs.class?.split(' ').includes('meo-table-scroll')
      ? node.children.find(child => isTag(child) && child.name === 'table') as Element | undefined : undefined;
    const part = table?.attribs['data-meo-preview-table-part'];
    const previousPart = previous?.attribs['data-meo-preview-table-part'];
    const body = table?.children.find(child => isTag(child) && child.name === 'tbody') as Element | undefined;
    const previousBody = previous?.children.find(child => isTag(child) && child.name === 'tbody') as Element | undefined;
    if (table && body && previous && previousBody && ['start', 'middle'].includes(previousPart ?? '')
      && ['middle', 'end'].includes(part ?? '')
      && previous.attribs['data-meo-preview-table-origin'] === table.attribs['data-meo-preview-table-origin']) {
      for (const row of [...body.children]) DomUtils.appendChild(previousBody, row);
      previous.attribs['data-meo-preview-table-part'] = part!;
      previous.attribs['data-source-end-line'] = table.attribs['data-source-end-line']!;
      DomUtils.removeElement(node);
    } else previous = part ? table : undefined;
  }
  for (const table of DomUtils.findAll(element => element.name === 'table', root.children)) {
    for (const attribute of ['data-meo-preview-table-part', 'data-meo-preview-table-widths', 'data-meo-preview-table-origin']) delete table.attribs[attribute];
  }
  return DomUtils.getOuterHTML(root.children);
}
