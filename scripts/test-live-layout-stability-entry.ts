import { createEditor } from './test-editor-factory';
import { getDetailsBlocks, toggleCollapsibleSection } from '../webview/src/helpers/headingCollapse';

(globalThis as typeof globalThis & {
  LiveLayoutStabilityHarness?: {
    createEditor: typeof createEditor;
    getDetailsBlocks: typeof getDetailsBlocks;
    toggleCollapsibleSection: typeof toggleCollapsibleSection;
  };
}).LiveLayoutStabilityHarness = { createEditor, getDetailsBlocks, toggleCollapsibleSection };
