import { history, isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { createEditorHistoryApplication, type EditorHistoryContext } from '../webview/src/application/editorHistory';
import {
  createEditorHistoryEffectAdapter,
  type EditorHistoryNativeResult,
  type EditorHistoryRestoreRequest
} from '../webview/src/adapters/editorHistoryEffectAdapter';
import { createEditorHistoryRuntime } from '../webview/src/adapters/editorHistoryRuntime';

type EditableMode = 'live' | 'source';
type BoundaryTarget =
  | { kind: 'rendered-block'; mode: 'preview' | 'split' | 'source' }
  | { kind: 'table-boundary' };

let view: EditorView;
let mode: EditableMode = 'source';
let boundaryTarget: BoundaryTarget | undefined;
let renderedMounted = true;
let pendingTransientText: string | null = null;
let lastHistoryRange: { from: number; to: number } | null = null;
let runtimeStarts = 0;
let boundaryRestores = 0;
let disposes = 0;
const nativeReplays: Array<'undo' | 'redo'> = [];
const errors: string[] = [];

const renderedInput = document.getElementById('rendered') as HTMLTextAreaElement;
const tableInput = document.getElementById('table-fixture') as HTMLTextAreaElement;

const setRenderedMode = (nextMode: 'preview' | 'split' | 'source'): void => {
  renderedInput.dataset.mode = nextMode;
};

const changedRangeFromUpdate = (update: ViewUpdate): void => {
  if (!update.docChanged) return;
  const isReplay = update.transactions.some((transaction) => {
    const event = transaction.annotation(Transaction.userEvent);
    return typeof event === 'string' && (event.startsWith('undo') || event.startsWith('redo'));
  });
  if (!isReplay) return;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
  });
  lastHistoryRange = Number.isFinite(from) ? { from, to } : null;
};

const captureContext = (): EditorHistoryContext => {
  const selectionHead = view.state.selection.main.head;
  const selectionLine = view.state.doc.lineAt(selectionHead).number;
  const visibleFromLine = view.state.doc.lineAt(view.viewport.from).number;
  const visibleToLine = view.state.doc.lineAt(view.viewport.to).number;
  return {
    viewport: {
      scrollTop: view.scrollDOM.scrollTop,
      selection: {
        lineNumber: selectionLine,
        visibleFromLineNumber: visibleFromLine,
        visibleToLineNumber: visibleToLine,
        wasVisible: selectionLine >= visibleFromLine && selectionLine <= visibleToLine
      }
    }
  };
};

const dispatchEdit = (insert: string): void => {
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert },
    selection: { anchor: end + insert.length },
    effects: EditorView.scrollIntoView(end + insert.length, { y: 'nearest' }),
    annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')]
  });
};

const restoreEditorInteraction = (request: EditorHistoryRestoreRequest): void => {
  const target = Math.max(0, Math.min(request.targetPosition ?? view.state.selection.main.head, view.state.doc.length));
  view.scrollDOM.scrollTop = request.previousViewport.scrollTop;
  view.dispatch({
    selection: { anchor: target },
    effects: EditorView.scrollIntoView(target, { y: 'nearest' })
  });
  view.focus();
};

const application = createEditorHistoryApplication();
const adapter = createEditorHistoryEffectAdapter({
  captureContext,
  commitTransientEdits() {
    if (pendingTransientText === null) return;
    const insert = pendingTransientText;
    pendingTransientText = null;
    dispatchEdit(insert);
  },
  runNativeHistory(direction): EditorHistoryNativeResult {
    lastHistoryRange = null;
    nativeReplays.push(direction);
    const applied = direction === 'undo' ? undo(view) : redo(view);
    return { applied, changedRange: lastHistoryRange };
  },
  attemptBoundaryRestore(request) {
    if (mode !== 'live') return 'not-rendered';
    if (boundaryTarget?.kind === 'table-boundary') {
      tableInput.value = view.state.doc.toString();
      tableInput.focus({ preventScroll: true });
      const offset = Math.min(request.targetPosition ?? 0, tableInput.value.length);
      tableInput.setSelectionRange(offset, offset);
      boundaryRestores += 1;
      return 'restored';
    }
    if (boundaryTarget?.kind !== 'rendered-block') return 'not-rendered';
    if (!renderedMounted) return 'retry';
    setRenderedMode(boundaryTarget.mode);
    renderedInput.value = view.state.doc.toString();
    renderedInput.focus({ preventScroll: true });
    const offset = Math.min(request.targetPosition ?? 0, renderedInput.value.length);
    renderedInput.setSelectionRange(offset, offset);
    boundaryRestores += 1;
    return 'restored';
  },
  restoreEditorInteraction,
  scheduleFocusRetry(run) {
    const frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  },
  reportError(operation, error) {
    errors.push(`${operation}:${String(error)}`);
  },
  dispose() {
    disposes += 1;
    view.destroy();
  }
});
const runtime = createEditorHistoryRuntime(application, adapter, (error) => errors.push(String(error)));
runtimeStarts += 1;

const replay = async (direction: 'undo' | 'redo'): Promise<boolean | null> => {
  const applied = await runtime.dispatch({ type: 'requestReplay', direction });
  await runtime.whenIdle();
  return applied;
};

const focusOwner = (): 'editor' | 'rendered-block' | 'table-boundary' | 'other' => {
  if (document.activeElement === renderedInput) return 'rendered-block';
  if (document.activeElement === tableInput) return 'table-boundary';
  if (view?.hasFocus) return 'editor';
  return 'other';
};

(window as any).__editorHistoryCandidate = {
  initialize() {
    const text = Array.from({ length: 100 }, (_, index) => `history candidate line ${index + 1}`).join('\n');
    const state = EditorState.create({
      doc: text,
      extensions: [history(), EditorView.updateListener.of(changedRangeFromUpdate)]
    });
    view = new EditorView({ state, parent: document.getElementById('app')! });
    setRenderedMode('preview');
  },
  async setMode(nextMode: EditableMode) {
    mode = nextMode;
    boundaryTarget = undefined;
    await runtime.dispatch({ type: 'presentationChanged' });
    await runtime.whenIdle();
  },
  edit(insert: string, nextMode: EditableMode) {
    mode = nextMode;
    boundaryTarget = undefined;
    dispatchEdit(insert);
  },
  editRendered(insert: string, blockMode: 'preview' | 'split' | 'source') {
    mode = 'live';
    boundaryTarget = { kind: 'rendered-block', mode: blockMode };
    setRenderedMode(blockMode);
    dispatchEdit(insert);
  },
  prepareTableTransient(insert: string) {
    mode = 'live';
    boundaryTarget = { kind: 'table-boundary' };
    pendingTransientText = insert;
  },
  setRenderedMounted(mounted: boolean) {
    renderedMounted = mounted;
    renderedInput.hidden = !mounted;
  },
  replay,
  whenIdle: () => runtime.whenIdle(),
  async externalPresent() {
    boundaryTarget = undefined;
    await runtime.dispatch({ type: 'externalDocumentPresented' });
    await runtime.whenIdle();
  },
  async exhaustHistory() {
    while (undoDepth(view.state) > 0) await replay('undo');
    const applied = await replay('undo');
    return { applied, state: runtime.getState() };
  },
  snapshot() {
    const head = view.state.selection.main.head;
    const coords = view.coordsAtPos(head);
    const viewport = view.scrollDOM.getBoundingClientRect();
    return {
      runtimeStarts,
      legacyCoordinatorStarts: 0,
      state: runtime.getState(),
      text: view.state.doc.toString(),
      history: { undo: undoDepth(view.state), redo: redoDepth(view.state) },
      nativeReplayTail: nativeReplays.slice(-2),
      focusOwner: focusOwner(),
      selectionHead: head,
      focusedHead: document.activeElement === renderedInput
        ? renderedInput.selectionStart
        : document.activeElement === tableInput ? tableInput.selectionStart : head,
      selectionVisible: Boolean(coords && coords.bottom > viewport.top && coords.top < viewport.bottom),
      renderedMode: renderedInput.dataset.mode ?? null,
      boundaryRestores,
      disposes,
      errors: [...errors]
    };
  },
  dispose() {
    runtime.dispose();
  }
};
