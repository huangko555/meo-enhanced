import { EditorView, type DecorationSet } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { createEditor } from './test-editor-factory';
import { isLiveInputDerivedWorkPending } from '../webview/src/editor/liveInputDerivedWork';
import { diagnosticDataField } from '../webview/src/helpers/diagnostics';
import { replaceLocalLinkStatuses } from '../webview/src/helpers/localLinks';

(window as any).__liveHistory = {
  create: createEditor,
  setLocalStatuses: replaceLocalLinkStatuses,
  pending: (editor: ReturnType<typeof createEditor>) => isLiveInputDerivedWorkPending(editor.view.state),
  diagnostics: (editor: ReturnType<typeof createEditor>) => editor.view.state.field(diagnosticDataField),
  decorations(editor: ReturnType<typeof createEditor>): DecorationSet {
    return editor.view.state.facet(EditorView.decorations)
      .filter((value): value is DecorationSet => typeof value !== 'function')
      .sort((left, right) => right.size - left.size)[0];
  },
  input(editor: ReturnType<typeof createEditor>, from: number, text: string, time?: number) {
    editor.view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length },
      annotations: [Transaction.userEvent.of('input.type'), ...(time === undefined ? [] : [Transaction.time.of(time)])] });
  }
};
