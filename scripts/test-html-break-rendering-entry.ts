import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  HtmlBreakRenderingHarness?: { createEditor: typeof createEditor };
}).HtmlBreakRenderingHarness = { createEditor };
