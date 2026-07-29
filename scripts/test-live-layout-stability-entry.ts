import { createEditor } from '../webview/src/editor';
import { toggleCollapsibleSection } from '../webview/src/helpers/headingCollapse';

(globalThis as typeof globalThis & {
  LiveLayoutStabilityHarness?: {
    createEditor: typeof createEditor;
    toggleCollapsibleSection: typeof toggleCollapsibleSection;
  };
}).LiveLayoutStabilityHarness = { createEditor, toggleCollapsibleSection };
