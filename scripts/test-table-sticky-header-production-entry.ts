import { createEditor } from './test-editor-factory';
import { installCausalFrameSettlement } from './causal-frame-settlement';

(globalThis as typeof globalThis & {
  TableStickyHeaderProductionHarness?: {
    createEditor: typeof createEditor;
    installCausalFrameSettlement: typeof installCausalFrameSettlement;
  };
}).TableStickyHeaderProductionHarness = {
  createEditor,
  installCausalFrameSettlement
};
