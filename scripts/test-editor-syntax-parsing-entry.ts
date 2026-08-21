import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  EditorSyntaxParsingHarness?: { createEditor: typeof createEditor };
}).EditorSyntaxParsingHarness = { createEditor };
