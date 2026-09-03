import darkPlus from '@shikijs/themes/dark-plus';
import { createEditor } from './test-editor-factory';
import { setShikiTheme, type RawVscodeTheme } from '../webview/src/helpers/shikiHighlighter';

setShikiTheme(darkPlus as RawVscodeTheme);

(globalThis as typeof globalThis & {
  CodeBlockLineNumbersHarness?: { createEditor: typeof createEditor };
}).CodeBlockLineNumbersHarness = { createEditor };
