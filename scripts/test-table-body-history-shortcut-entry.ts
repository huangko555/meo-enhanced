import { createEditor } from './test-editor-factory';
import { handleEditorShortcut } from '../webview/src/helpers/shortcuts';

(globalThis as typeof globalThis & {
  TableBodyHistoryHarness?: { createEditor: typeof createEditor; handleEditorShortcut: typeof handleEditorShortcut };
}).TableBodyHistoryHarness = { createEditor, handleEditorShortcut };
