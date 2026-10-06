import mermaid from 'mermaid';
import { createEditor } from './test-editor-factory';
import { editorViewportBounds } from '../webview/src/editor/editorViewportBounds';

(globalThis as typeof globalThis & {
  mermaid?: typeof mermaid;
  EmbeddedInputViewportHarness?: { createEditor: typeof createEditor; editorViewportBounds: typeof editorViewportBounds };
}).mermaid = mermaid;

(globalThis as typeof globalThis & {
  EmbeddedInputViewportHarness?: { createEditor: typeof createEditor; editorViewportBounds: typeof editorViewportBounds };
}).EmbeddedInputViewportHarness = { createEditor, editorViewportBounds };
