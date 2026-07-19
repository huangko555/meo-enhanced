import { createEditor } from '../webview/src/editor';

(globalThis as typeof globalThis & {
  LongCodeBlocksHarness?: { createEditor: typeof createEditor };
}).LongCodeBlocksHarness = { createEditor };
