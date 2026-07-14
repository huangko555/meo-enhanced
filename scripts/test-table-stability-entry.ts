import { createEditor } from '../webview/src/editor';
import {
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver
} from '../webview/src/helpers/images';

(globalThis as typeof globalThis & {
  TableStabilityHarness?: {
    createEditor: typeof createEditor;
    handleImagePaste: typeof handleImagePaste;
    handleSavedImagePath: typeof handleSavedImagePath;
    initializeImageHandling: typeof initializeImageHandling;
    setImageSrcResolver: typeof setImageSrcResolver;
  };
}).TableStabilityHarness = {
  createEditor,
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver
};
