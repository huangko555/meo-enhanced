import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { ViewportController, ViewportHistorySnapshot } from './viewportController';

export type EditorHistoryDirection = 'undo' | 'redo';

type EditorHistoryRunner = (direction: EditorHistoryDirection) => boolean;
const editorHistoryRunnerKey = Symbol('meoEditorHistoryRunner');

type EditorHistoryHost = HTMLElement & {
  [editorHistoryRunnerKey]?: EditorHistoryRunner;
};

export function setEditorHistoryRunner(view: EditorView, runner: EditorHistoryRunner | null): void {
  const host = view.dom as EditorHistoryHost;
  if (runner) {
    host[editorHistoryRunnerKey] = runner;
  } else {
    delete host[editorHistoryRunnerKey];
  }
}

export function runEditorHistoryCommand(view: EditorView, direction: EditorHistoryDirection): boolean {
  const runner = (view.dom as EditorHistoryHost)[editorHistoryRunnerKey];
  if (runner) {
    return runner(direction);
  }
  return direction === 'undo' ? undo(view) : redo(view);
}

export function consumeEditorHistoryCommand(view: EditorView, direction: EditorHistoryDirection): boolean {
  runEditorHistoryCommand(view, direction);
  // Never allow the browser's native contenteditable history to run after the
  // shared document history reaches its boundary. It can replay stale inner
  // editor DOM and appear as an unexpected redo.
  return true;
}

export interface HistoryFocusIntent {
  readonly generation: number;
  isCurrent(): boolean;
  retry(focus: () => boolean): void;
}

export interface HistoryReplayContext {
  direction: EditorHistoryDirection;
  previousDocument: string;
  previousViewport: ViewportHistorySnapshot;
  targetPosition: number | null;
  preferredBlockMode?: 'preview' | 'split' | 'source';
}

export interface HistoryEntry {
  beforeDocument: string;
  afterDocument: string;
  beforeSelection: { anchor: number; head: number };
  afterSelection: { anchor: number; head: number };
  semanticPosition: number;
  mode: 'live' | 'source';
  beforeViewport: ViewportHistorySnapshot;
  afterViewport: ViewportHistorySnapshot;
  source: string;
  blockMode?: 'preview' | 'split' | 'source';
}

interface HistoryCoordinatorOptions {
  commitPendingEdits(): void;
  restoreFocus(context: HistoryReplayContext, intent: HistoryFocusIntent): void;
  getMode?(): 'live' | 'source';
  captureBlockModeAt?(position: number): 'preview' | 'split' | 'source' | undefined;
}

export function changedDocumentRange(before: string, after: string): { from: number; to: number } | null {
  let from = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (from < sharedLength && before.charCodeAt(from) === after.charCodeAt(from)) from += 1;
  if (from === before.length && from === after.length) return null;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > from &&
    afterEnd > from &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { from, to: afterEnd };
}

/**
 * Owns the single global history command path and the lifetime of semantic
 * focus restoration. Renderers may locate a target, but only this coordinator
 * may keep a pending focus request alive across widget mounting.
 */
export class HistoryCoordinator {
  private focusGeneration = 0;
  private pendingFocus: (() => boolean) | null = null;
  private focusObserver: MutationObserver | null = null;
  private focusFrame: number | null = null;
  private scrollGuard: ViewportHistorySnapshot | null = null;
  private destroyed = false;
  private lastViewport: ViewportHistorySnapshot;
  private readonly entries: HistoryEntry[] = [];
  private readonly redoEntries: HistoryEntry[] = [];
  private lastUndoDepth = 0;
  private lastRedoDepth = 0;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const isHistory = (event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y');
    const isModifier = key === 'control' || key === 'shift' || key === 'alt' || key === 'meta' || key === 'altgraph';
    if (isHistory) {
      const target = event.target instanceof Element ? event.target : null;
      const toolbarTarget = target?.closest('.meo-mermaid-toolbar, .meo-latex-math-toolbar');
      if (toolbarTarget) {
        event.preventDefault();
        event.stopPropagation();
        this.run(key === 'z' && !event.shiftKey ? 'undo' : 'redo');
        return;
      }
    }
    if (!isHistory && !isModifier && !this.tryPendingFocus()) this.cancelFocusIntent();
  };

  private readonly onBeforeInput = (event: InputEvent) => {
    if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') {
      if (!this.tryPendingFocus()) this.cancelFocusIntent();
    }
  };

  private readonly onPointerDown = () => this.cancelFocusIntent();
  private readonly onBlur = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.view.dom.contains(next)) return;
    queueMicrotask(() => {
      if (!this.view.dom.contains(this.view.dom.ownerDocument.activeElement)) this.cancelFocusIntent();
    });
  };

  constructor(
    private readonly view: EditorView,
    private readonly viewport: ViewportController,
    private readonly options: HistoryCoordinatorOptions
  ) {
    this.lastViewport = viewport.captureCurrentHistorySnapshot();
    this.lastUndoDepth = undoDepth(view.state);
    this.lastRedoDepth = redoDepth(view.state);
    setEditorHistoryRunner(view, (direction) => this.run(direction));
    view.dom.addEventListener('keydown', this.onKeyDown, true);
    view.dom.addEventListener('beforeinput', this.onBeforeInput, true);
    view.dom.addEventListener('pointerdown', this.onPointerDown, true);
    view.dom.addEventListener('blur', this.onBlur, true);
  }

  recordUserEdit(update: ViewUpdate): void {
    if (this.destroyed || !update.docChanged) return;
    const userEvent = update.transactions.reduce<string | undefined>(
      (current, transaction) => transaction.annotation(Transaction.userEvent) ?? current,
      undefined
    );
    if (!userEvent || userEvent.startsWith('undo') || userEvent.startsWith('redo')) return;
    const before = update.startState.doc.toString();
    const after = update.state.doc.toString();
    const entry: HistoryEntry = {
      beforeDocument: before,
      afterDocument: after,
      beforeSelection: {
        anchor: update.startState.selection.main.anchor,
        head: update.startState.selection.main.head
      },
      afterSelection: {
        anchor: update.state.selection.main.anchor,
        head: update.state.selection.main.head
      },
      semanticPosition: update.state.selection.main.head,
      mode: this.options.getMode?.() ?? 'source',
      beforeViewport: this.lastViewport,
      afterViewport: this.lastViewport,
      source: userEvent,
      blockMode: this.options.captureBlockModeAt?.(update.state.selection.main.head)
    };
    this.entries.push(entry);
    this.redoEntries.length = 0;
    this.lastViewport = entry.afterViewport;
    this.lastUndoDepth = undoDepth(this.view.state);
    this.lastRedoDepth = redoDepth(this.view.state);
  }

  getHistoryDepth(): { undo: number; redo: number } {
    return { undo: undoDepth(this.view.state), redo: redoDepth(this.view.state) };
  }


  run(direction: EditorHistoryDirection): boolean {
    if (this.destroyed) return false;
    this.cancelFocusIntent();
    this.options.commitPendingEdits();

    const previousDocument = this.view.state.doc.toString();
    const previousViewport = this.viewport.captureHistorySnapshot();
    const preferredBlockMode = this.options.captureBlockModeAt?.(this.view.state.selection.main.head);
    this.scrollGuard = previousViewport;
    const applied = direction === 'undo' ? undo(this.view) : redo(this.view);
    if (!applied) {
      this.scrollGuard = null;
      return false;
    }

    const sourceEntries = direction === 'undo' ? this.entries : this.redoEntries;
    let entryIndex = -1;
    for (let index = sourceEntries.length - 1; index >= 0; index -= 1) {
      const candidate = sourceEntries[index];
      if (direction === 'undo' ? candidate.afterDocument === previousDocument : candidate.beforeDocument === previousDocument) {
        entryIndex = index;
        break;
      }
    }
    const entry = entryIndex >= 0
      ? sourceEntries.splice(entryIndex, 1)[0]
      : sourceEntries.pop();
    if (entry) {
      if (direction === 'undo') this.redoEntries.push(entry);
      else this.entries.push(entry);
    }
    this.lastUndoDepth = undoDepth(this.view.state);
    this.lastRedoDepth = redoDepth(this.view.state);

    const changed = changedDocumentRange(previousDocument, this.view.state.doc.toString());
    const targetPosition = changed
      ? direction === 'undo' ? changed.from : changed.to
      : null;
    const generation = ++this.focusGeneration;
    const intent: HistoryFocusIntent = {
      generation,
      isCurrent: () => !this.destroyed && generation === this.focusGeneration,
      retry: (focus) => this.installPendingFocus(generation, focus)
    };
    this.options.restoreFocus({
      direction,
      previousDocument,
      previousViewport,
      targetPosition,
      preferredBlockMode: entry?.blockMode ?? preferredBlockMode
    }, intent);

    // The guard only suppresses CodeMirror's synchronous history scroll. Any
    // later layout correction is owned by ViewportController.
    queueMicrotask(() => {
      if (generation === this.focusGeneration) this.scrollGuard = null;
    });
    return true;
  }

  shouldSuppressScroll(position: number): boolean {
    const guard = this.scrollGuard;
    if (!guard) return false;
    const coords = this.view.coordsAtPos(position);
    const viewport = this.view.scrollDOM.getBoundingClientRect();
    if (coords) {
      return coords.top >= viewport.top && coords.bottom <= viewport.bottom;
    }
    const block = this.view.lineBlockAt(position);
    return block.bottom > this.view.scrollDOM.scrollTop
      && block.top < this.view.scrollDOM.scrollTop + this.view.scrollDOM.clientHeight;
  }

  cancelFocusIntent(): void {
    this.focusGeneration += 1;
    this.pendingFocus = null;
    this.scrollGuard = null;
    if (this.focusFrame !== null) cancelAnimationFrame(this.focusFrame);
    this.focusFrame = null;
    this.focusObserver?.disconnect();
    this.focusObserver = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelFocusIntent();
    setEditorHistoryRunner(this.view, null);
    this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
    this.view.dom.removeEventListener('beforeinput', this.onBeforeInput, true);
    this.view.dom.removeEventListener('pointerdown', this.onPointerDown, true);
    this.view.dom.removeEventListener('blur', this.onBlur, true);
  }

  private installPendingFocus(generation: number, focus: () => boolean): void {
    if (generation !== this.focusGeneration || this.destroyed) return;
    this.pendingFocus = focus;
    if (this.tryPendingFocus()) return;

    this.focusObserver?.disconnect();
    this.focusObserver = new MutationObserver(() => this.tryPendingFocus());
    this.focusObserver.observe(this.view.dom, { childList: true, subtree: true });
    this.view.requestMeasure({
      read: () => null,
      write: () => this.tryPendingFocus()
    });
    this.schedulePendingFocusFrame();
  }

  private schedulePendingFocusFrame(): void {
    if (!this.pendingFocus || this.focusFrame !== null || this.destroyed) return;
    this.focusFrame = requestAnimationFrame(() => {
      this.focusFrame = null;
      if (!this.tryPendingFocus()) this.schedulePendingFocusFrame();
    });
  }

  private tryPendingFocus(): boolean {
    const focus = this.pendingFocus;
    if (!focus || this.destroyed) return false;
    if (!focus()) return false;
    this.pendingFocus = null;
    this.focusObserver?.disconnect();
    this.focusObserver = null;
    if (this.focusFrame !== null) cancelAnimationFrame(this.focusFrame);
    this.focusFrame = null;
    return true;
  }
}
