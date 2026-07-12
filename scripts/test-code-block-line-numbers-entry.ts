import { createEditor } from '../webview/src/editor';

(globalThis as typeof globalThis & {
  CodeBlockLineNumbersHarness?: { createEditor: typeof createEditor };
}).CodeBlockLineNumbersHarness = { createEditor };
