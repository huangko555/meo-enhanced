import { createEditor } from './test-editor-factory';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';

(globalThis as typeof globalThis & {
  InlineCodeLayoutHarness?: {
    createEditor: typeof createEditor;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
  };
}).InlineCodeLayoutHarness = { createEditor, applyBuiltInVisualBaseline };
