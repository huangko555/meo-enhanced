import { createEditor } from './test-editor-factory';
import { getDetailsBlocks, toggleDetailsBlock } from '../webview/src/helpers/detailsBlocks';

(globalThis as typeof globalThis & {
  LiveLayoutStabilityHarness?: {
    createEditor: typeof createEditor;
    getDetailsBlocks: typeof getDetailsBlocks;
    toggleCollapsibleSection: typeof toggleDetailsBlock;
  };
}).LiveLayoutStabilityHarness = {
  createEditor,
  getDetailsBlocks,
  toggleCollapsibleSection: toggleDetailsBlock
};
