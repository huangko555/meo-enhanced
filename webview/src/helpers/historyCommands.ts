import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';

export type EditorHistoryDirection = 'undo' | 'redo';

type EditorHistoryRunner = (direction: EditorHistoryDirection) => void | Promise<unknown>;
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
    runner(direction);
    return true;
  }
  return direction === 'undo' ? undo(view) : redo(view);
}

export function consumeEditorHistoryCommand(view: EditorView, direction: EditorHistoryDirection): boolean {
  runEditorHistoryCommand(view, direction);
  // The Runtime result is asynchronous, but the contenteditable event must be
  // consumed synchronously even when native history is already at a boundary.
  return true;
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
