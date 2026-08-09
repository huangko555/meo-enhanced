import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  CodeBlockLineNumbersHarness?: { createEditor: typeof createEditor };
}).CodeBlockLineNumbersHarness = { createEditor };
