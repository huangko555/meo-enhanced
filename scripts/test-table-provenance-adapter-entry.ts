import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createTableTransactionProvenance } from '../webview/src/application/tableTransactionProvenance';
import { createCodeMirrorTableTransactionProvenanceAdapter } from '../webview/src/adapters/codeMirrorTableTransactionProvenanceAdapter';

const module = createTableTransactionProvenance();
const adapter = createCodeMirrorTableTransactionProvenanceAdapter(module);
let view: EditorView;
let lateEffect: ReturnType<typeof adapter.effect> | undefined;
let moduleStarts = 1;
let adapterStarts = 1;

const initialize = (text: string): void => {
  view = new EditorView({
    parent: document.getElementById('app')!,
    state: EditorState.create({ doc: text, extensions: [history(), adapter.extension] })
  });
  document.getElementById('insert-row')?.addEventListener('click', () => insertRow(4, '| same |'));
  document.getElementById('delete-row')?.addEventListener('click', () => deleteRows(4, 4, [[3, 3]], false));
};

const insertRow = (lineNumber: number, text: string): void => {
  const line = view.state.doc.line(lineNumber);
  view.dispatch({
    changes: { from: line.from, insert: `${text}\n` },
    effects: adapter.effect({ type: 'insertedRow', at: line.from, assoc: -1 }),
    annotations: [Transaction.userEvent.of('input.table.insert-row'), isolateHistory.of('full')]
  });
};

const deleteRows = (
  fromLineNumber: number,
  toLineNumber: number,
  baselineRanges: ReadonlyArray<readonly [number, number]>,
  deletionAtEnd: boolean
): void => {
  const fromLine = view.state.doc.line(fromLineNumber);
  const toLine = view.state.doc.line(toLineNumber);
  const to = Math.min(view.state.doc.length, toLine.to + 1);
  view.dispatch({
    changes: { from: fromLine.from, to },
    effects: adapter.effect({
      type: 'deletedRows', at: fromLine.from, assoc: deletionAtEnd ? -1 : 1,
      baselineRanges, deletionAtEnd
    }),
    annotations: [Transaction.userEvent.of('delete.table.rows'), isolateHistory.of('full')]
  });
};

const edit = (from: number, to: number, insert: string): void => {
  view.dispatch({ changes: { from, to, insert }, annotations: Transaction.userEvent.of('input.type') });
};

const remapTable = (
  fromLineNumber: number,
  toLineNumber: number,
  replacement: string,
  rows: ReadonlyArray<{ readonly id: string; readonly oldOffset: number; readonly newOffset: number }>
): void => {
  const fromLine = view.state.doc.line(fromLineNumber);
  const toLine = view.state.doc.line(toLineNumber);
  view.dispatch({
    changes: { from: fromLine.from, to: toLine.to, insert: replacement },
    effects: adapter.effect({ type: 'remapInsertedRows', tableFrom: fromLine.from, rows }),
    annotations: Transaction.userEvent.of('input.table.remap')
  });
};

const reset = (type: 'baselineRefreshed' | 'externalDocumentPresented'): void => {
  view.dispatch({
    effects: adapter.effect({ type }),
    annotations: Transaction.addToHistory.of(false)
  });
};

const captureLateInsertedEffect = (lineNumber: number): void => {
  lateEffect = adapter.effect({ type: 'insertedRow', at: view.state.doc.line(lineNumber).from, assoc: -1 });
};

const dispatchLateEffect = (): void => {
  if (lateEffect) view.dispatch({ effects: lateEffect, annotations: Transaction.addToHistory.of(false) });
};

(window as any).__tableProvenanceCandidate = {
  initialize,
  insertRow,
  deleteRows,
  edit,
  remapTable,
  baselineRefreshed: () => reset('baselineRefreshed'),
  externalDocumentPresented: () => reset('externalDocumentPresented'),
  captureLateInsertedEffect,
  dispatchLateEffect,
  undo: () => undo(view),
  redo: () => redo(view),
  snapshot: () => ({
    text: view.state.doc.toString(),
    provenance: adapter.snapshot(),
    moduleStarts,
    adapterStarts,
    legacyStarts: 0
  }),
  disposeAdapter: () => adapter.dispose(),
  destroy() {
    view.destroy();
  }
};
