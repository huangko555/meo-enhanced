import darkPlus from '@shikijs/themes/dark-plus';
import { createEditor } from './test-editor-factory';
import { setShikiTheme } from '../webview/src/helpers/shikiHighlighter';

(globalThis as typeof globalThis & {
  SourceLightweightShikiHarness?: {
    createEditor: typeof createEditor;
    applyTheme(): void;
  };
}).SourceLightweightShikiHarness = {
  createEditor,
  applyTheme() {
    setShikiTheme(darkPlus);
  }
};
