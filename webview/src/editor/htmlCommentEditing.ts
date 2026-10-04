import { EditorSelection, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { isExternalDocumentPresentation } from './externalDocumentPresentation';

export type CommentTemplate = { readonly from: number; readonly to: number; readonly end: number };
export const beginHtmlCommentTemplate = StateEffect.define<CommentTemplate>();
const commentTemplate = StateField.define<CommentTemplate | null>({
  create: () => null,
  update(field, transaction) {
    if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.reconfigured || isExternalDocumentPresentation(transaction)) return null;
    if (field) field = { from: transaction.changes.mapPos(field.from, -1), to: transaction.changes.mapPos(field.to, 1), end: transaction.changes.mapPos(field.end, 1) };
    for (const effect of transaction.effects) {
      if (effect.is(beginHtmlCommentTemplate)) field = effect.value;
      if (effect.is(endHtmlCommentTemplate)) field = null;
    }
    if (field) {
      const selection = transaction.state.selection.main;
      if (selection.from < field.from || selection.to > field.to || transaction.state.selection.ranges.length !== 1
        || transaction.newDoc.sliceString(field.from - 4, field.from) !== '<!--' || transaction.newDoc.sliceString(field.to, field.end) !== '-->') return null;
    }
    return field;
  }
});
const endHtmlCommentTemplate = StateEffect.define<null>();

/** Only the newly created comment owns Tab. Leaving it restores normal editor navigation. */
export const htmlCommentEditing: Extension = [commentTemplate, keymap.of([
  { key: 'Tab', run(view) {
    const field = view.state.field(commentTemplate);
    if (!field || view.state.readOnly || view.compositionStarted) return false;
    view.dispatch({ selection: EditorSelection.cursor(field.end), effects: endHtmlCommentTemplate.of(null), scrollIntoView: true });
    return true;
  } },
  { key: 'Escape', run(view) {
    if (!view.state.field(commentTemplate) || view.compositionStarted) return false;
    view.dispatch({ effects: endHtmlCommentTemplate.of(null) }); return true;
  } },
  { key: 'Enter', run(view) {
    const field = view.state.field(commentTemplate);
    if (!field || view.state.readOnly || view.compositionStarted || field.from !== field.to || !view.state.selection.main.empty) return false;
    const line = view.state.doc.lineAt(field.from);
    if (view.state.sliceDoc(line.from, field.from - 4).trim() || view.state.sliceDoc(field.end, line.to).trim()) return false;
    view.dispatch({ changes: { from: field.from, insert: '\n\n' }, selection: EditorSelection.cursor(field.from + 1),
      annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')], scrollIntoView: true });
    return true;
  } }
])];
