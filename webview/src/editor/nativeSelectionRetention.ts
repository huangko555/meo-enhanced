import type { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { restoreEditorNativeSelection } from './layoutMeasurement';

function nativeSelectionMatches(view: EditorView, selection: EditorSelection): boolean {
  const native = view.dom.ownerDocument.getSelection();
  if (!native?.anchorNode || !native.focusNode || !view.contentDOM.contains(native.anchorNode)
    || !view.contentDOM.contains(native.focusNode)) return false;
  try {
    return view.posAtDOM(native.anchorNode, native.anchorOffset) === selection.main.anchor
      && view.posAtDOM(native.focusNode, native.focusOffset) === selection.main.head;
  } catch { return false; }
}

/** A decoration-only DOM rewrite must not move a native caret that already
 * agrees with the accepted selection. Never adopt a pending native selection,
 * steal focus from a widget, or interfere with composition and mode changes. */
export function applyPrimaryEditorTransactions(transactions: readonly Transaction[], view: EditorView): void {
  const before = view.state;
  const eligible = transactions.length > 0 && transactions.every(transaction =>
    !transaction.docChanged && !transaction.selection && !transaction.reconfigured)
    && view.dom.ownerDocument.activeElement === view.contentDOM && !view.compositionStarted
    && nativeSelectionMatches(view, before.selection);
  view.update(transactions);
  if (eligible && view.state.doc === before.doc && view.state.selection.eq(before.selection)
    && view.dom.ownerDocument.activeElement === view.contentDOM && !view.compositionStarted
    && !nativeSelectionMatches(view, view.state.selection)) {
    restoreEditorNativeSelection(view);
  }
}
