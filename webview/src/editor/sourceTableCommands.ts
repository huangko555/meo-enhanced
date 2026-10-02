import { Transaction, EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { EditorCommandId } from '../../../src/foundation/editingPreferences';
import type { TableCommand } from '../application/tableCommand';
import { externalTableCellToMarkdown, markdownTableFromCells, parseMarkdownTable, type MarkdownTable } from '../application/delimitedTable';
import type { TableClipboardMatrix } from './tableClipboard';
import type { TableCommandEditorTarget } from './tableCommandAdapter';

export const tableShortcutCommands: Partial<Record<EditorCommandId, TableCommand>> = {
  rowAbove: 'insert-row-above', rowBelow: 'insert-row-below', rowDelete: 'delete-row', columnBefore: 'insert-column-left', columnAfter: 'insert-column-right', columnDelete: 'delete-column',
  moveRowUp: 'move-row-up', moveRowDown: 'move-row-down', moveColumnLeft: 'move-column-left', moveColumnRight: 'move-column-right', alignLeft: 'align-left', alignCenter: 'align-center', alignRight: 'align-right'
};
export type SourceTable = { readonly from: number; readonly to: number; readonly row: number; readonly column: number; readonly prefix: string; readonly matrix: MarkdownTable };
export function sourceTableAt(state: EditorState, position = state.selection.main.head): SourceTable | null {
  let node = syntaxTree(state).resolveInner(position, -1);
  while (node.parent && node.name !== 'Table') node = node.parent;
  if (node.name !== 'Table') return null;
  const matrix = parseMarkdownTable(state.sliceDoc(node.from, node.to)); if (!matrix) return null;
  const line = state.doc.lineAt(position), first = state.doc.lineAt(node.from);
  const row = Math.max(0, Math.min(matrix.cells.length - 1, line.number - first.number - (line.number > first.number ? 1 : 0)));
  const prefix = /^\s*(?:>\s*)*/.exec(first.text)?.[0] ?? '';
  const partial = line.text.slice(0, position - line.from);
  let separators = 0, slashes = 0;
  for (const character of partial) { if (character === '|' && slashes % 2 === 0) separators++; slashes = character === '\\' ? slashes + 1 : 0; }
  const column = Math.max(0, Math.min(matrix.cells[0].length - 1, separators - (line.text.replace(/^\s*(?:>\s*)*/, '').startsWith('|') ? 1 : 0)));
  return { from: node.from, to: node.to, row, column, prefix, matrix };
}
export function sourceTableTransaction(table: SourceTable, matrix: MarkdownTable, row = table.row, column = table.column): TransactionSpec {
  const lines = markdownTableFromCells(matrix.cells, true).split('\n');
  lines[1] = '| ' + matrix.alignments.map(alignment => alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : alignment === 'left' ? ':---' : '---').join(' | ') + ' |';
  const insert = lines.map((line, index) => index ? table.prefix + line : line).join('\n');
  const lineIndex = Math.max(0, Math.min(matrix.cells.length - 1, row)) + (row > 0 ? 1 : 0);
  const columnIndex = Math.max(0, Math.min(matrix.cells[0].length - 1, column));
  const preceding = lines.slice(0, lineIndex).reduce((total, line, index) => total + line.length + (index ? table.prefix.length : 0) + 1, 0);
  const cellOffset = matrix.cells[Math.min(row, matrix.cells.length - 1)].slice(0, columnIndex).reduce((total, cell) => total + cell.length + 3, 2);
  return { changes: { from: table.from, to: table.to, insert }, selection: EditorSelection.cursor(Math.min(table.from + insert.length, table.from + preceding + (lineIndex ? table.prefix.length : 0) + cellOffset)), annotations: [Transaction.userEvent.of('input.table-command'), isolateHistory.of('full')] };
}
export function sourceTablePaste(state: EditorState, payload: TableClipboardMatrix): TransactionSpec | null {
  const table = sourceTableAt(state); if (!table) return null;
  const cells = table.matrix.cells.map(row => row.slice()); const alignments = table.matrix.alignments.slice();
  const width = Math.max(cells[0].length, table.column + payload.cells[0].length);
  const height = Math.max(cells.length, table.row + payload.cells.length);
  if (width * height > 10_000) return null;
  for (const row of cells) while (row.length < width) row.push('');
  while (cells.length < height) cells.push(Array<string>(width).fill(''));
  while (alignments.length < width) alignments.push(null);

  payload.cells.forEach((row, r) => row.forEach((value, c) => { cells[table.row + r][table.column + c] = payload.source === 'meo' ? value : externalTableCellToMarkdown(value); }));
  return sourceTableTransaction(table, { cells, alignments });
}
export function createSourceTableCommandTarget(view: EditorView, initial: SourceTable, preserveViewport: (run: () => void) => void): TableCommandEditorTarget {
  return {
    view, identityKey: 'source-table', from: initial.from, isConnected: () => view.dom.isConnected && sourceTableAt(view.state)?.from === initial.from, preserveViewport,
    buildAtomicCommandTransaction({ command }) {
      const table = sourceTableAt(view.state);
      if (!table || table.from !== initial.from) return { transaction: null, outcome: 'no-op' };
      const cells = table.matrix.cells.map(row => row.slice()); const alignments = table.matrix.alignments.slice(); let row = table.row, column = table.column;
      const width = cells[0].length;
      if (command === 'insert-row-above' || command === 'insert-row-below') {
        if (command === 'insert-row-above' && row === 0 || (cells.length + 1) * width > 10_000) return { transaction: null, outcome: 'no-op' };
        if (command === 'insert-row-below') row++;
        cells.splice(row, 0, Array<string>(width).fill(''));
      } else if (command === 'delete-row') {
        if (row === 0 || cells.length <= 2) return { transaction: null, outcome: 'no-op' };
        cells.splice(row, 1); row = Math.min(row, cells.length - 1);
      } else if (command === 'move-row-up' || command === 'move-row-down') {
        const next = row + (command === 'move-row-up' ? -1 : 1);
        if (row === 0 || next <= 0 || next >= cells.length) return { transaction: null, outcome: 'no-op' };
        [cells[row], cells[next]] = [cells[next], cells[row]]; row = next;
      } else if (command === 'insert-column-left' || command === 'insert-column-right') {
        if (cells.length * (width + 1) > 10_000) return { transaction: null, outcome: 'no-op' };
        if (command === 'insert-column-right') column++;
        cells.forEach(row => row.splice(column, 0, '')); alignments.splice(column, 0, null);
      } else if (command === 'delete-column') {
        if (width <= 1) return { transaction: null, outcome: 'no-op' };
        cells.forEach(row => row.splice(column, 1)); alignments.splice(column, 1); column = Math.min(column, width - 2);
      } else if (command === 'move-column-left' || command === 'move-column-right') {
        const next = column + (command === 'move-column-left' ? -1 : 1);
        if (next < 0 || next >= width) return { transaction: null, outcome: 'no-op' };
        cells.forEach(row => { [row[column], row[next]] = [row[next], row[column]]; });
        [alignments[column], alignments[next]] = [alignments[next], alignments[column]]; column = next;
      } else alignments[column] = command === 'align-left' ? 'left' : command === 'align-center' ? 'center' : 'right';
      return { transaction: sourceTableTransaction(table, { cells, alignments }, row, column), outcome: 'changed', preserveViewport: true };
    }
  };
}
