import { createEditor } from './test-editor-factory';
import { installCausalFrameSettlement } from './causal-frame-settlement';
import {
  initializeImageHandling,
  setImageSrcResolver
} from '../webview/src/helpers/images';

(globalThis as typeof globalThis & {
  TableStickyHeaderProductionHarness?: {
    createEditor: typeof createEditor;
    installCausalFrameSettlement: typeof installCausalFrameSettlement;
    initializeImageHandling: typeof initializeImageHandling;
    setImageSrcResolver: typeof setImageSrcResolver;
  };
}).TableStickyHeaderProductionHarness = {
  createEditor,
  installCausalFrameSettlement,
  initializeImageHandling,
  setImageSrcResolver
};
