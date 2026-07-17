import { createEditor } from '../webview/src/editor';
import {
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver
} from '../webview/src/helpers/images';
import { replaceLocalLinkStatuses } from '../webview/src/helpers/localLinks';

(globalThis as typeof globalThis & {
  TableStabilityHarness?: {
    createEditor: typeof createEditor;
    handleImagePaste: typeof handleImagePaste;
    handleSavedImagePath: typeof handleSavedImagePath;
    initializeImageHandling: typeof initializeImageHandling;
    setImageSrcResolver: typeof setImageSrcResolver;
    replaceLocalLinkStatuses: typeof replaceLocalLinkStatuses;
  };
}).TableStabilityHarness = {
  createEditor,
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver,
  replaceLocalLinkStatuses
};
