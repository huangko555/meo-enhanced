import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  SourceLightweightTableColumnWidthHarness?: {
    createEditor: typeof createEditor;
  };
}).SourceLightweightTableColumnWidthHarness = { createEditor };
