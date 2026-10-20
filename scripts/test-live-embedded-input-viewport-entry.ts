import mermaid from 'mermaid';
import { createEditor } from './test-editor-factory';
import { editorViewportBounds } from '../webview/src/editor/editorViewportBounds';
import { tableCellSourceRangeForInput } from '../webview/src/helpers/tables';

(globalThis as typeof globalThis & {
  mermaid?: typeof mermaid;
  EmbeddedInputViewportHarness?: { createEditor: typeof createEditor; editorViewportBounds: typeof editorViewportBounds; tableCellSourceRangeForInput: typeof tableCellSourceRangeForInput };
}).mermaid = mermaid;

(globalThis as typeof globalThis & {
  EmbeddedInputViewportHarness?: { createEditor: typeof createEditor; editorViewportBounds: typeof editorViewportBounds; tableCellSourceRangeForInput: typeof tableCellSourceRangeForInput };
}).EmbeddedInputViewportHarness = { createEditor, editorViewportBounds, tableCellSourceRangeForInput };
