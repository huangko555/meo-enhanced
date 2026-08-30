import mermaid from 'mermaid';
import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  mermaid?: typeof mermaid;
  EmbeddedInputViewportHarness?: { createEditor: typeof createEditor };
}).mermaid = mermaid;

(globalThis as typeof globalThis & {
  EmbeddedInputViewportHarness?: { createEditor: typeof createEditor };
}).EmbeddedInputViewportHarness = { createEditor };
