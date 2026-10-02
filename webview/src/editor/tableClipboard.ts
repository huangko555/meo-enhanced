import { clipboardHtmlToMarkdown } from './htmlPaste';
import { parseDelimitedTable } from '../application/delimitedTable';
export const meoTableClipboardMime = 'application/x-meo-table-cells+json';

export interface TableClipboardMatrix {
  readonly cells: readonly (readonly string[])[];
  readonly source: 'meo' | 'external';
}

const maxClipboardCells = 10_000;
const maxClipboardCharacters = 5_000_000;

function normalizeMatrix(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows: string[][] = [];
  let width = 0;
  let count = 0;
  let characters = 0;
  for (const candidate of value) {
    if (!Array.isArray(candidate)) return null;
    const row: string[] = [];
    for (const cell of candidate) {
      if (typeof cell !== 'string') return null;
      characters += cell.length;
      if (characters > maxClipboardCharacters) return null;
      row.push(cell);
      count += 1;
      if (count > maxClipboardCells) return null;
    }
    width = Math.max(width, row.length);
    rows.push(row);
  }
  if (width === 0 || rows.length * width > maxClipboardCells) return null;
  return rows.map((row) => [...row, ...new Array(width - row.length).fill('')]);
}

export function serializeMeoTableClipboard(cells: readonly (readonly string[])[]): string {
  return JSON.stringify({ version: 1, cells });
}

export function parseMeoTableClipboard(value: string): TableClipboardMatrix | null {
  if (!value || value.length > maxClipboardCharacters) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || !('cells' in parsed)) return null;
    const payload = parsed as { readonly version: unknown; readonly cells: unknown };
    if (payload.version !== 1) return null;
    const cells = normalizeMatrix(payload.cells);
    return cells ? { cells, source: 'meo' } : null;
  } catch {
    return null;
  }
}

/** Parses the tab-delimited clipboard shape produced by spreadsheet applications. */
export function parseTsvTableClipboard(value: string): TableClipboardMatrix | null {
  if (!value.includes('\t') || value.length > maxClipboardCharacters) return null;
  const cells = parseDelimitedTable(value, '\t');
  return cells ? { cells, source: 'external' } : null;
}

export function parseHtmlTableClipboard(value: string, preserveFormatting = false): TableClipboardMatrix | null {
  if (!value || value.length > maxClipboardCharacters || typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(value, 'text/html');
  const table = document.querySelector('table');
  if (!table) return null;
  const sourceRows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table);
  if (sourceRows.length > maxClipboardCells) return null;
  const rows: string[][] = [];
  const occupied = new Set<string>();
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return '';
    if (node.tagName === 'BR') return '\n';
    const content = Array.from(node.childNodes, text).join('');
    return ['P', 'DIV'].includes(node.tagName) ? content + '\n' : content;
  };
  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex++) {
    const row = rows[rowIndex] ??= [];
    let column = 0;
    for (const cell of Array.from(sourceRows[rowIndex].children).filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH')) {
      while (occupied.has(rowIndex + ':' + column)) column++;
      const colspan = Math.max(1, Number(cell.getAttribute('colspan') ?? 1));
      const rawRowspan = Number(cell.getAttribute('rowspan') ?? 1);
      const rowspan = rawRowspan === 0 ? sourceRows.length - rowIndex : Math.max(1, rawRowspan);
      if (!Number.isInteger(colspan) || !Number.isInteger(rowspan) || colspan * rowspan > maxClipboardCells || column + colspan > maxClipboardCells || rowIndex + rowspan > maxClipboardCells) return null;
      for (let r = rowIndex; r < rowIndex + rowspan; r++) {
        const target = rows[r] ??= [];
        for (let c = column; c < column + colspan; c++) {
          const key = r + ':' + c;
          if (occupied.has(key)) return null;
          occupied.add(key); if (occupied.size > maxClipboardCells) return null;
          target[c] = r === rowIndex && c === column ? preserveFormatting
            ? (clipboardHtmlToMarkdown(cell.innerHTML) ?? '').replace(/<br>\n/g, '<br>')
            : Array.from(cell.childNodes, text).join('').replace(/\n$/, '') : '';
        }
      }
      column += colspan;
    }
  }
  const cells = normalizeMatrix(rows.map(row => Array.from({ length: row.length }, (_, index) => row[index] ?? '')));
  return cells ? { cells, source: preserveFormatting ? 'meo' : 'external' } : null;
}
