import { editorViewportBounds } from '../webview/src/editor/editorViewportBounds';
import { createEditor } from './test-editor-factory';
import { getDetailsBlocks, toggleDetailsBlock } from '../webview/src/helpers/detailsBlocks';

(globalThis as typeof globalThis & {
  LiveLayoutStabilityHarness?: {
    createEditor: typeof createEditor;
    editorViewportBounds: typeof editorViewportBounds;
    getDetailsBlocks: typeof getDetailsBlocks;
    toggleDetailsBlock: typeof toggleDetailsBlock;
  };
}).LiveLayoutStabilityHarness = {
  createEditor,
  editorViewportBounds,
  getDetailsBlocks,
  toggleDetailsBlock
};
