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
  if (width === 0) return null;
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
  const rows: string[][] = [[]];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === '\t') {
      rows[rows.length - 1].push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && value[index + 1] === '\n') index += 1;
      rows[rows.length - 1].push(cell);
      rows.push([]);
      cell = '';
    } else {
      cell += character;
    }
  }
  rows[rows.length - 1].push(cell);
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  const cells = normalizeMatrix(rows);
  return cells ? { cells, source: 'external' } : null;
}

export function parseHtmlTableClipboard(value: string): TableClipboardMatrix | null {
  if (!value || value.length > maxClipboardCharacters || typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(value, 'text/html');
  const table = document.querySelector('table');
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll('tr'), (row) => (
    Array.from(row.children)
      .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
      .map((cell) => cell.textContent ?? '')
  )).filter((row) => row.length > 0);
  const cells = normalizeMatrix(rows);
  return cells ? { cells, source: 'external' } : null;
}
