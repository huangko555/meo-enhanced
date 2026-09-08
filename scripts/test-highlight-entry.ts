import { createEditor } from './test-editor-factory';
import { createSelectionMenu } from '../webview/src/helpers/selectionMenu';
import { createCodePaletteWebviewAdapter } from '../webview/src/adapters/codePaletteWebviewAdapter';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { applyPreviewCodeHighlight } from '../webview/src/helpers/previewCodeHighlight';
import { activateShikiCodeHighlighting, setShikiTheme } from '../webview/src/helpers/shikiHighlighter';
import { EditorView } from '@codemirror/view';
import { shikiDocumentHighlight } from '../webview/src/helpers/shikiDecorations';

function createStandaloneHighlightEditor(parent: HTMLElement, text: string, language = 'typescript') {
  const view = new EditorView({ parent, doc: text, extensions: [shikiDocumentHighlight(language)] });
  return { view, getText: () => view.state.doc.toString(), focus: () => view.focus(), destroy: () => view.destroy() };
}

(globalThis as typeof globalThis & {
  HighlightHarness?: {
    createEditor: typeof createEditor;
    createSelectionMenu: typeof createSelectionMenu;
    createCodePaletteWebviewAdapter: typeof createCodePaletteWebviewAdapter;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
    applyPreviewCodeHighlight: typeof applyPreviewCodeHighlight;
    activateShikiCodeHighlighting: typeof activateShikiCodeHighlighting;
    setShikiTheme: typeof setShikiTheme;
    createStandaloneHighlightEditor: typeof createStandaloneHighlightEditor;
  };
}).HighlightHarness = {
  createEditor,
  createSelectionMenu,
  createCodePaletteWebviewAdapter,
  applyBuiltInVisualBaseline,
  applyPreviewCodeHighlight,
  activateShikiCodeHighlighting,
  setShikiTheme,
  createStandaloneHighlightEditor
};
