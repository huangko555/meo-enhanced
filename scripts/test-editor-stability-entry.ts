import { createEditor } from '../webview/src/editor';
import { createOutlineController } from '../webview/src/helpers/outline';

(globalThis as typeof globalThis & {
  EditorStabilityHarness?: {
    createEditor: typeof createEditor;
    createOutlineController: typeof createOutlineController;
  };
}).EditorStabilityHarness = { createEditor, createOutlineController };
