import { createEditor, refreshMermaidTheme } from './test-editor-factory';

(globalThis as typeof globalThis & {
  MermaidEditingHarness?: {
    createEditor: typeof createEditor;
    refreshMermaidTheme: typeof refreshMermaidTheme;
  };
}).MermaidEditingHarness = { createEditor, refreshMermaidTheme };
