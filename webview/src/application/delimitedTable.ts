const maxCharacters = 5_000_000;
const maxCells = 10_000;

/** CSV/TSV interchange, including escaped quotes, quoted newlines and CRLF. */
export function parseDelimitedTable(text: string, delimiter: ',' | '\t'): string[][] | null {
  if (!text || text.length > maxCharacters) return null;
  const rows: string[][] = [[]];
  let value = '';
  let quoted = false;
  let closedQuote = false;
  let cells = 0;
  const finishCell = () => {
    rows[rows.length - 1].push(value);
    value = ''; closedQuote = false;
    return ++cells <= maxCells;
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (character === '"') { quoted = false; closedQuote = true; }
      else if (character === '\r') { value += '\n'; if (text[index + 1] === '\n') index++; }
      else value += character;
      continue;
    }
    if (character === '"' && value === '' && !closedQuote) { quoted = true; continue; }
    if (character === delimiter) { if (!finishCell()) return null; continue; }
    if (character === '\r' || character === '\n') {
      if (!finishCell()) return null;
      rows.push([]);
      if (character === '\r' && text[index + 1] === '\n') index++;
      continue;
    }
    if (closedQuote) { if (character !== ' ' && character !== '\t') return null; continue; }
    value += character;
  }
  if (quoted) return null;
  if (rows.length > 1 && rows.at(-1)!.length === 0 && value === '' && /[\r\n]$/.test(text)) rows.pop();
  else if (!finishCell()) return null;
  const width = Math.max(...rows.map(row => row.length));
  if (rows.length * width > maxCells) return null;
  return rows.map(row => [...row, ...Array<string>(width - row.length).fill('')]);
}

export function serializeDelimitedTable(cells: readonly (readonly string[])[], delimiter: ',' | '\t'): string {
  return cells.map(row => row.map(value => /["\r\n]/.test(value) || value.includes(delimiter) || /^\s|\s$/.test(value)
    ? '"' + value.replaceAll('"', '""') + '"' : value).join(delimiter)).join('\r\n');
}

/** External cells are text, so Markdown and HTML metacharacters stay visible. */
export function externalTableCellToMarkdown(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_\[\]~=$|]/g, '\\$&').replace(/\r\n?|\n/g, '<br>');
}
export function markdownTableFromCells(cells: readonly (readonly string[])[], sourceMarkdown = false): string {
  if (!cells.length || !cells[0].length) return '';
  const cell = (value: string) => {
    const escaped = sourceMarkdown ? value.replace(/(\\*)\|/g, (match, slashes: string) => slashes.length % 2 ? match : slashes + '\\|')
      : externalTableCellToMarkdown(value);
    return escaped.replace(/\r\n?|\n/g, '<br>');
  };
  const row = (values: readonly string[]) => '| ' + values.map(cell).join(' | ') + ' |';
  return [row(cells[0]), row(cells[0].map(() => '---')), ...cells.slice(1).map(row)].join('\n');
}
export type MarkdownTable = { readonly cells: string[][]; readonly alignments: ('left' | 'center' | 'right' | null)[] };
export function splitMarkdownTableRow(line: string): string[] {
  const content = line.replace(/^\s*(?:>\s*)*/, '').trim();
  const cells: string[] = []; let value = ''; let slashes = 0; let trailingDelimiter = false;
  for (const character of content) {
    trailingDelimiter = character === '|' && slashes % 2 === 0;
    if (trailingDelimiter) { cells.push(value.trim()); value = ''; }
    else value += character;
    slashes = character === '\\' ? slashes + 1 : 0;
  }
  cells.push(value.trim());
  if (content.startsWith('|')) cells.shift();
  if (trailingDelimiter) cells.pop();
  return cells;
}
export function parseMarkdownTable(text: string): MarkdownTable | null {
  if (text.length > 5_000_000) return null;
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return null;
  const separator = splitMarkdownTableRow(lines[1]);
  if (!separator.length || separator.some(cell => !/^:?-+:?$/.test(cell))) return null;
  const cells = [splitMarkdownTableRow(lines[0]), ...lines.slice(2).map(splitMarkdownTableRow)];
  const width = separator.length;
  if (cells[0].length !== width || cells.length * width > maxCells) return null;
  return { cells: cells.map(row => [...row.slice(0, width), ...Array<string>(Math.max(0, width - row.length)).fill('')]), alignments: separator.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null) };
}

/** Rows count data rows; the header counts toward the existing table interchange capacity. */
export function isMarkdownTableSize(cols: number, rows: number): boolean {
  return Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && cols >= 1 && rows >= 1 && (rows + 1) * cols <= maxCells;
}
/** Invalid sizes never fall back to the default table. */
export function emptyMarkdownTable(cols = 3, rows = 2): string | null {
  if (!isMarkdownTableSize(cols, rows)) return null;
  return markdownTableFromCells(Array.from({ length: rows + 1 }, () => Array<string>(cols).fill('')), true);
}
