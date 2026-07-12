import { createEditor } from '../webview/src/editor';

(globalThis as typeof globalThis & {
  MermaidEditingHarness?: { createEditor: typeof createEditor };
}).MermaidEditingHarness = { createEditor };
