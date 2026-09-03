import darkPlus from '@shikijs/themes/dark-plus';
import { Transaction } from '@codemirror/state';
import { createEditor } from './test-editor-factory';
import { setShikiTheme } from '../webview/src/helpers/shikiHighlighter';

(globalThis as typeof globalThis & {
  SourceLightweightShikiHarness?: {
    createEditor: typeof createEditor;
    applyTheme(): void;
    pasteText(editor: ReturnType<typeof createEditor>, from: number, to: number, text: string): void;
  };
}).SourceLightweightShikiHarness = {
  createEditor,
  applyTheme() {
    setShikiTheme(darkPlus);
  },
  pasteText(editor, from, to, text) {
    editor.view.dispatch({
      changes: { from, to, insert: text },
      annotations: Transaction.userEvent.of('input.paste')
    });
  }
};
