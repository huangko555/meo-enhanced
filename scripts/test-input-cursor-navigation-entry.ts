import { createEditor } from './test-editor-factory';

(window as typeof window & {
  __createInputCursorEditor?: typeof createEditor;
}).__createInputCursorEditor = createEditor;
