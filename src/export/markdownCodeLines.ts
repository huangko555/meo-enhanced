import MarkdownIt from 'markdown-it';

// Only block types and source ranges participate in this index. The default
// inline phase would parse every paragraph again for each preprocessing pass.
const structureParser = new MarkdownIt().disable('inline');

/** Code is opaque to table/list normalization and footnote substitution, including
 * fences and indented code inside lists and quotes. Line indexes are zero based. */
export function collectMarkdownCodeLines(markdownText: string, onFenceInfo?: (info: string) => void): Set<number> {
  return scanCodeLines(markdownText, onFenceInfo);
}

/** A balanced, single-line inline tag cannot change block boundaries when
 * inserted after existing paragraph/heading content. Container prefixes and
 * link definitions are not content; use the parser's actual inline source. */
export function inspectMarkdownCodeLines(markdownText: string) {
  const sourceLines = markdownText.split(/\r?\n/);
  const inlineStarts = new Map<number, number>();
  const tableRows = new Set<number>();
  const codeLines = scanCodeLines(markdownText, undefined, node => {
    if (!node.map) return;
    if (node.type === 'tr_open') {
      for (let line = node.map[0]; line < node.map[1]; line++) tableRows.add(line);
    }
    if (node.type !== 'inline') return;
    const contentLines = node.content.split('\n');
    for (let index = 0; index < contentLines.length && node.map[0] + index < node.map[1]; index++) {
      const line = node.map[0] + index;
      const content = contentLines[index]!;
      if (!content.trim()) continue;
      const start = sourceLines[line]?.indexOf(content) ?? -1;
      if (start >= 0) inlineStarts.set(line, start);
    }
  });
  return {
    codeLines,
    canInsertInlineHtmlAt(line: number, column: number, end: number, html: string) {
      // Removing a label's pipe can also turn a previously invalid table
      // header into a table. Keep fresh parsing in either direction.
      if (/[|\r\n]/.test(sourceLines[line]?.slice(column, end) ?? '') || /[|\r\n]/.test(html)) return false;
      // Table cells have no node.map. The enclosing row does. A balanced tag
      // preserves that row only if the replaced label contains no pipe and
      // the inserted tag introduces neither a pipe nor a line boundary.
      if (tableRows.has(line)) return true;
      const start = inlineStarts.get(line);
      return start !== undefined && column >= start && !!sourceLines[line]?.slice(start, column).trim();
    }
  };
}

function scanCodeLines(markdownText: string, onFenceInfo?: (info: string) => void,
  onToken?: (node: ReturnType<MarkdownIt['parse']>[number]) => void): Set<number> {
  const lines = new Set<number>();
  for (const node of structureParser.parse(markdownText, {})) {
    onToken?.(node);
    if ((node.type !== 'fence' && node.type !== 'code_block') || !node.map) continue;
    if (node.type === 'fence') onFenceInfo?.(node.info);
    // Live accepts standalone indented tables. Preserve that extension while
    // keeping actual code payloads (including table-looking fenced code) opaque.
    if (node.type === 'code_block') {
      const rows = node.content.trim().split('\n');
      if (rows.length >= 2 && rows[0].includes('|')
        && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(rows[1])
        && rows.slice(2).every(row => row.includes('|'))) continue;
    }
    for (let index = node.map[0]; index < node.map[1]; index += 1) lines.add(index);
  }
  return lines;
}
