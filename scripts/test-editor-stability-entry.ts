import { createEditor } from './test-editor-factory';
import { createOutlineController } from '../webview/src/helpers/outline';
import { createSelectionMenu, createSelectionMenuController } from '../webview/src/helpers/selectionMenu';
import { setGitDiffDetailsVisible } from '../webview/src/helpers/gitDiffDetails';
import { setGitDiffLineHighlightsEnabled } from '../webview/src/helpers/gitDiffLineHighlights';

(globalThis as typeof globalThis & {
  EditorStabilityHarness?: {
    createEditor: typeof createEditor;
    createOutlineController: typeof createOutlineController;
    createSelectionMenu: typeof createSelectionMenu;
    createSelectionMenuController: typeof createSelectionMenuController;
    setGitDiffDetailsVisible: typeof setGitDiffDetailsVisible;
    setGitDiffLineHighlightsEnabled: typeof setGitDiffLineHighlightsEnabled;
  };
}).EditorStabilityHarness = {
  createEditor,
  createOutlineController,
  createSelectionMenu,
  createSelectionMenuController,
  setGitDiffDetailsVisible,
  setGitDiffLineHighlightsEnabled
};
