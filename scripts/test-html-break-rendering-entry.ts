import { createEditor } from '../webview/src/editor';

(globalThis as typeof globalThis & {
  HtmlBreakRenderingHarness?: { createEditor: typeof createEditor };
}).HtmlBreakRenderingHarness = { createEditor };
