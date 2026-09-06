import { createEditor } from './test-editor-factory';
import { createOutlineController } from '../webview/src/helpers/outline';
import { createSelectionMenu, createSelectionMenuController } from '../webview/src/helpers/selectionMenu';
import { setGitDiffDetailsVisible } from '../webview/src/helpers/gitDiffDetails';
import { setGitDiffLineHighlightsEnabled } from '../webview/src/helpers/gitDiffLineHighlights';
import { EditorView } from '@codemirror/view';
import { setDiagnosticsEffect } from '../webview/src/helpers/diagnostics';

(globalThis as typeof globalThis & {
  EditorStabilityHarness?: {
    createEditor: typeof createEditor;
    createOutlineController: typeof createOutlineController;
    createSelectionMenu: typeof createSelectionMenu;
    createSelectionMenuController: typeof createSelectionMenuController;
    setGitDiffDetailsVisible: typeof setGitDiffDetailsVisible;
    setGitDiffLineHighlightsEnabled: typeof setGitDiffLineHighlightsEnabled;
    EditorView: typeof EditorView;
    setDiagnosticsEffect: typeof setDiagnosticsEffect;
  };
}).EditorStabilityHarness = {
  createEditor,
  createOutlineController,
  createSelectionMenu,
  createSelectionMenuController,
  setGitDiffDetailsVisible,
  setGitDiffLineHighlightsEnabled,
  EditorView,
  setDiagnosticsEffect
};
