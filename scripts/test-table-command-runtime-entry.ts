import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createTableCommandApplication, type TableCommand } from '../webview/src/application/tableCommand';
import { createTableTransactionProvenance } from '../webview/src/application/tableTransactionProvenance';
import { createTableCommandRuntime } from '../webview/src/adapters/tableCommandRuntime';
import { createCodeMirrorTableTransactionProvenanceAdapter } from '../webview/src/adapters/codeMirrorTableTransactionProvenanceAdapter';
import {
  createCodeMirrorTableCommandEffectAdapter,
  type TableCommandEditorTarget
} from '../webview/src/editor/internal/codeMirrorTableCommandEffectAdapter';

type Matrix = { header: string[]; alignments: Array<'left' | 'center' | 'right' | null>; rows: string[][] };
type LocatedTable = Matrix & { from: number; to: number; index: number };

const splitRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '')
  .split('|').map((cell) => cell.trim());
const alignment = (cell: string): 'left' | 'center' | 'right' | null => {
  const value = cell.trim();
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.endsWith(':')) return 'right';
  if (value.startsWith(':')) return 'left';
  return null;
};
const delimiter = (value: Matrix['alignments'][number]): string => (
  value === 'center' ? ':---:' : value === 'right' ? '---:' : value === 'left' ? ':---' : '---'
);
const serialize = (matrix: Matrix): string => [
  `| ${matrix.header.join(' | ')} |`,
  `| ${matrix.alignments.map(delimiter).join(' | ')} |`,
  ...matrix.rows.map((row) => `| ${row.join(' | ')} |`)
].join('\n');

const locateTables = (doc: string): LocatedTable[] => {
  const lines = doc.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const result: LocatedTable[] = [];
  for (let line = 0; line < lines.length - 1;) {
    if (!lines[line].trim().startsWith('|') || !lines[line + 1].includes('---')) {
      line += 1;
      continue;
    }
    let end = line + 2;
    while (end < lines.length && lines[end].trim().startsWith('|')) end += 1;
    result.push({
      index: result.length,
      from: starts[line],
      to: end < lines.length ? starts[end] - 1 : doc.length,
      header: splitRow(lines[line]),
      alignments: splitRow(lines[line + 1]).map(alignment),
      rows: lines.slice(line + 2, end).map(splitRow)
    });
    line = end;
  }
  return result;
};

const pending = new Map<string, Map<string, string>>();
const previewOrders = new Map<string, number[]>();
const previewDirections = new Map<string, 'asc' | 'desc'>();
let view: EditorView;
let documentTransactions = 0;
let restoreCount = 0;
let reportCount = 0;
let consumedCount = 0;

const tableIdFor = (index: number) => `table-${index + 1}`;
const tableFor = (tableId: string): LocatedTable | null => {
  const index = Number.parseInt(tableId.slice('table-'.length), 10) - 1;
  return locateTables(view.state.doc.toString())[index] ?? null;
};
const applyPending = (tableId: string, table: LocatedTable): Matrix => {
  const matrix: Matrix = {
    header: [...table.header], alignments: [...table.alignments], rows: table.rows.map((row) => [...row])
  };
  for (const [key, value] of pending.get(tableId) ?? []) {
    const [row, col] = key.split(':').map(Number);
    if (row === 0 && matrix.header[col] !== undefined) matrix.header[col] = value;
    else if (row > 0 && matrix.rows[row - 1]?.[col] !== undefined) matrix.rows[row - 1][col] = value;
  }
  return matrix;
};
const replaceTable = (table: LocatedTable, matrix: Matrix, effects: TransactionSpec['effects'] = []): TransactionSpec => ({
  changes: { from: table.from, to: table.to, insert: serialize(matrix) },
  effects,
  annotations: [Transaction.userEvent.of('input.table.command'), isolateHistory.of('full')]
});

const provenanceModule = createTableTransactionProvenance();
const provenanceAdapter = createCodeMirrorTableTransactionProvenanceAdapter(provenanceModule);
const editorHost = document.getElementById('editor')!;
const uiHost = document.getElementById('tables')!;

const render = (): void => {
  uiHost.replaceChildren();
  for (const table of locateTables(view.state.doc.toString())) {
    const tableId = tableIdFor(table.index);
    const matrix = applyPending(tableId, table);
    const order = previewOrders.get(tableId) ?? matrix.rows.map((_row, index) => index);
    const shell = document.createElement('section');
    shell.dataset.tableId = tableId;
    const tableElement = document.createElement('table');
    const body = document.createElement('tbody');
    for (const [visualRow, sourceRow] of order.entries()) {
      const tr = document.createElement('tr');
      for (let col = 0; col < matrix.header.length; col += 1) {
        const td = document.createElement('td');
        td.contentEditable = 'true';
        td.dataset.row = String(sourceRow + 1);
        td.dataset.col = String(col);
        td.dataset.visualRow = String(visualRow + 1);
        td.textContent = matrix.rows[sourceRow]?.[col] ?? '';
        td.addEventListener('input', () => {
          let edits = pending.get(tableId);
          if (!edits) pending.set(tableId, edits = new Map());
          edits.set(`${sourceRow + 1}:${col}`, td.textContent ?? '');
        });
        tr.append(td);
      }
      body.append(tr);
    }
    tableElement.append(body);
    shell.append(tableElement);
    for (const command of [
      'insert-row-above', 'insert-row-below', 'delete-row',
      'insert-column-left', 'insert-column-right', 'delete-column',
      'align-left', 'align-center', 'align-right', 'preview-sort', 'apply-sort'
    ] satisfies TableCommand[]) {
      const button = document.createElement('button');
      button.dataset.command = command;
      button.textContent = command;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        consumedCount += event.defaultPrevented ? 1 : 0;
        const current = tableFor(tableId);
        const enabled = Boolean(current && !(
          (command === 'delete-row' && current.rows.length <= 1) ||
          (command === 'delete-column' && current.header.length <= 1) ||
          (command === 'apply-sort' && !previewOrders.has(tableId))
        ));
        void runtime.dispatch({
          type: 'request', command, target: { tableId, row: 1, column: 0 }, enabled
        });
      });
      shell.append(button);
    }
    uiHost.append(shell);
  }
};

const targetFor = (tableId: string): TableCommandEditorTarget | null => {
  const current = tableFor(tableId);
  if (!current) return null;
  return {
    view,
    buildPendingEditTransaction() {
      const table = tableFor(tableId);
      if (!table || !(pending.get(tableId)?.size)) return null;
      const matrix = applyPending(tableId, table);
      pending.delete(tableId);
      return replaceTable(table, matrix);
    },
    buildAtomicCommandTransaction(request) {
      const table = tableFor(tableId);
      if (!table) return { transaction: null, outcome: 'no-op' };
      const matrix = applyPending(tableId, table);
      pending.delete(tableId);
      const row = Math.max(0, Math.min((request.target.row ?? 1) - 1, Math.max(0, matrix.rows.length - 1)));
      const col = Math.max(0, Math.min(request.target.column ?? 0, Math.max(0, matrix.header.length - 1)));
      let effects: TransactionSpec['effects'] = [];
      switch (request.command) {
        case 'insert-row-above':
        case 'insert-row-below': {
          const at = request.command === 'insert-row-above' ? row : row + 1;
          matrix.rows.splice(at, 0, new Array(matrix.header.length).fill(''));
          const offset = serialize(matrix).split('\n').slice(0, at + 2).join('\n').length + 1;
          effects = provenanceAdapter.effect({ type: 'insertedRow', at: table.from, assoc: -1, offset });
          break;
        }
        case 'delete-row':
          if (matrix.rows.length <= 1) return { transaction: null, outcome: 'no-op' };
          matrix.rows.splice(row, 1);
          effects = provenanceAdapter.effect({
            type: 'deletedRows', at: table.from, assoc: 1,
            baselineRanges: [[row + 1, row + 1]], deletionAtEnd: row === table.rows.length - 1
          });
          break;
        case 'insert-column-left':
        case 'insert-column-right': {
          const at = request.command === 'insert-column-left' ? col : col + 1;
          matrix.header.splice(at, 0, '');
          matrix.alignments.splice(at, 0, null);
          matrix.rows.forEach((cells) => cells.splice(at, 0, ''));
          break;
        }
        case 'delete-column':
          if (matrix.header.length <= 1) return { transaction: null, outcome: 'no-op' };
          matrix.header.splice(col, 1);
          matrix.alignments.splice(col, 1);
          matrix.rows.forEach((cells) => cells.splice(col, 1));
          break;
        case 'align-left': matrix.alignments[col] = 'left'; break;
        case 'align-center': matrix.alignments[col] = 'center'; break;
        case 'align-right': matrix.alignments[col] = 'right'; break;
        case 'apply-sort': {
          const order = previewOrders.get(tableId);
          if (!order) return { transaction: null, outcome: 'no-op' };
          matrix.rows = order.map((index) => matrix.rows[index]);
          previewOrders.delete(tableId);
          previewDirections.delete(tableId);
          break;
        }
      }
      previewOrders.delete(tableId);
      previewDirections.delete(tableId);
      const transaction = replaceTable(table, matrix, effects);
      return serialize(matrix) === view.state.doc.sliceString(table.from, table.to)
        ? { transaction: null, outcome: 'no-op' }
        : { transaction, outcome: 'changed' };
    },
    presentCommand(request) {
      const table = tableFor(tableId);
      if (!table || table.rows.length <= 1) return 'no-op';
      const column = Math.max(0, Math.min(request.target.column ?? 0, table.header.length - 1));
      const direction = previewDirections.get(tableId) === 'desc' ? 'asc' : 'desc';
      const order = table.rows.map((_row, index) => index).sort((left, right) => {
        const result = table.rows[left][column].localeCompare(table.rows[right][column], undefined, { numeric: true });
        return direction === 'asc' ? result : -result;
      });
      previewDirections.set(tableId, direction);
      previewOrders.set(tableId, order);
      render();
      return 'presented';
    },
    restoreInteraction(request) {
      restoreCount += 1;
      const shell = uiHost.querySelector<HTMLElement>(`[data-table-id="${tableId}"]`);
      const cells = shell?.querySelectorAll<HTMLElement>('td') ?? [];
      const columnCount = tableFor(tableId)?.header.length ?? 1;
      const index = Math.max(0, Math.min(cells.length - 1,
        Math.max(0, (request.target.row ?? 1) - 1) * columnCount + Math.max(0, request.target.column ?? 0)));
      cells[index]?.focus({ preventScroll: true });
    }
  };
};

const application = createTableCommandApplication();
const effectAdapter = createCodeMirrorTableCommandEffectAdapter({
  resolveTarget: targetFor,
  reportError() { reportCount += 1; },
  dispose() {}
});
const runtime = createTableCommandRuntime(application, effectAdapter, () => { reportCount += 1; });

const initialize = (text: string): void => {
  view?.destroy();
  pending.clear();
  previewOrders.clear();
  previewDirections.clear();
  documentTransactions = 0;
  restoreCount = 0;
  reportCount = 0;
  consumedCount = 0;
  view = new EditorView({
    parent: editorHost,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(), provenanceAdapter.extension,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) documentTransactions += 1;
          if (update.docChanged) render();
        })
      ]
    })
  });
  render();
};

const externalPresent = (text: string): void => {
  pending.clear();
  previewOrders.clear();
  previewDirections.clear();
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    effects: provenanceAdapter.effect({ type: 'externalDocumentPresented' }),
    annotations: Transaction.addToHistory.of(false)
  });
};

(window as any).__tableCommandCandidate = {
  initialize,
  waitIdle: () => runtime.whenIdle(),
  undo: () => undo(view),
  redo: () => redo(view),
  externalPresent,
  dispatch: runtime.dispatch,
  snapshot: () => ({
    text: view.state.doc.toString(),
    transactions: documentTransactions,
    provenance: provenanceAdapter.snapshot(),
    restoreCount,
    reportCount,
    consumedCount,
    phase: runtime.getState().phase,
    preview: Array.from(previewOrders.entries()),
    activeText: document.activeElement?.textContent ?? '',
    applicationStarts: 1,
    runtimeStarts: 1,
    adapterStarts: 1,
    legacyStarts: 0
  }),
  dispose() { runtime.dispose(); view.destroy(); }
};
