import { createEditor } from './test-editor-factory';
import { createSelectionMenu } from '../webview/src/helpers/selectionMenu';

(globalThis as typeof globalThis & {
  HighlightHarness?: {
    createEditor: typeof createEditor;
    createSelectionMenu: typeof createSelectionMenu;
  };
}).HighlightHarness = { createEditor, createSelectionMenu };
