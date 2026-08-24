import { createEditor } from './test-editor-factory';
import { installCausalFrameSettlement } from './causal-frame-settlement';
import { setImageSrcResolver } from '../webview/src/helpers/images';

(globalThis as typeof globalThis & {
  TableStickyHeaderProductionHarness?: {
    createEditor: typeof createEditor;
    installCausalFrameSettlement: typeof installCausalFrameSettlement;
    setImageSrcResolver: typeof setImageSrcResolver;
  };
}).TableStickyHeaderProductionHarness = {
  createEditor,
  installCausalFrameSettlement,
  setImageSrcResolver
};
