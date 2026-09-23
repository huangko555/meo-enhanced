import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  LineNumberTypingHarness?: { createEditor: typeof createEditor };
}).LineNumberTypingHarness = { createEditor };
