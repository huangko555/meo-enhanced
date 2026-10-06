import MarkdownIt from 'markdown-it';

const structureParser = new MarkdownIt();

/** Code is opaque to table/list normalization and footnote substitution, including
 * fences and indented code inside lists and quotes. Line indexes are zero based. */
export function collectMarkdownCodeLines(markdownText: string): Set<number> {
  const lines = new Set<number>();
  for (const token of structureParser.parse(markdownText, {})) {
    if ((token.type !== 'fence' && token.type !== 'code_block') || !token.map) continue;
    // Live accepts standalone indented tables. Preserve that extension while
    // keeping actual code payloads (including table-looking fenced code) opaque.
    if (token.type === 'code_block') {
      const rows = token.content.trim().split('\n');
      if (rows.length >= 2 && rows[0].includes('|')
        && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(rows[1])
        && rows.slice(2).every(row => row.includes('|'))) continue;
    }
    for (let index = token.map[0]; index < token.map[1]; index += 1) lines.add(index);
  }
  return lines;
}
