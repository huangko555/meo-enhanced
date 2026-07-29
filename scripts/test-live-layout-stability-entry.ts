import { createEditor } from '../webview/src/editor';
import { getDetailsBlocks, toggleCollapsibleSection } from '../webview/src/helpers/headingCollapse';

(globalThis as typeof globalThis & {
  LiveLayoutStabilityHarness?: {
    createEditor: typeof createEditor;
    getDetailsBlocks: typeof getDetailsBlocks;
    toggleCollapsibleSection: typeof toggleCollapsibleSection;
  };
}).LiveLayoutStabilityHarness = { createEditor, getDetailsBlocks, toggleCollapsibleSection };
