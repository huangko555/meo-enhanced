import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  LargeDocumentBenchmarkHarness?: { readonly createEditor: typeof createEditor };
}).LargeDocumentBenchmarkHarness = { createEditor };
