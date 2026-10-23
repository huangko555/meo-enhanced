import { createEditor } from './test-editor-factory';
import { getLiveRenderedBlocks } from '../webview/src/helpers/liveRenderedBlocks';
import { bindTooltips } from '../webview/src/adapters/tooltip';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';
import { handleEditorShortcut } from '../webview/src/helpers/shortcuts';
import { effectiveShortcuts } from '../src/application/editingPreferences';

(globalThis as typeof globalThis & {
  HtmlContentHarness?: {
    createEditor: typeof createEditor;
    getLiveRenderedBlocks: typeof getLiveRenderedBlocks;
    bindTooltips: typeof bindTooltips;
    applyUiTheme: typeof applyUiTheme;
    handleEditorShortcut: typeof handleEditorShortcut;
    effectiveShortcuts: typeof effectiveShortcuts;
  };
}).HtmlContentHarness = { createEditor, getLiveRenderedBlocks, bindTooltips, applyUiTheme, handleEditorShortcut, effectiveShortcuts };
