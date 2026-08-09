import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  LongCodeBlocksHarness?: { createEditor: typeof createEditor };
}).LongCodeBlocksHarness = { createEditor };
