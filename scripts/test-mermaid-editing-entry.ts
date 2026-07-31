import { createEditor } from '../webview/src/editor';
import { refreshMermaidTheme } from '../webview/src/helpers/mermaidDiagram';

(globalThis as typeof globalThis & {
  MermaidEditingHarness?: {
    createEditor: typeof createEditor;
    refreshMermaidTheme: typeof refreshMermaidTheme;
  };
}).MermaidEditingHarness = { createEditor, refreshMermaidTheme };
