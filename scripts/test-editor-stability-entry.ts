import { createEditor } from './test-editor-factory';
import { createOutlineController } from '../webview/src/helpers/outline';
import { createSelectionMenu, createSelectionMenuController } from '../webview/src/helpers/selectionMenu';

(globalThis as typeof globalThis & {
  EditorStabilityHarness?: {
    createEditor: typeof createEditor;
    createOutlineController: typeof createOutlineController;
    createSelectionMenu: typeof createSelectionMenu;
    createSelectionMenuController: typeof createSelectionMenuController;
  };
}).EditorStabilityHarness = {
  createEditor,
  createOutlineController,
  createSelectionMenu,
  createSelectionMenuController
};
