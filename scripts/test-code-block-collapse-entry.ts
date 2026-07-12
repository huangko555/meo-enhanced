import { createEditor } from '../webview/src/editor';

(globalThis as typeof globalThis & {
  CodeBlockCollapseHarness?: { createEditor: typeof createEditor };
}).CodeBlockCollapseHarness = { createEditor };
