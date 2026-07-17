import { createEditor } from '../webview/src/editor';
import {
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver
} from '../webview/src/helpers/images';
import { getLocalLinkStatus, replaceLocalLinkStatuses } from '../webview/src/helpers/localLinks';
import { resolveInlineSourceOffsetAtPoint } from '../webview/src/helpers/inlinePresentation';

(globalThis as typeof globalThis & {
  TableStabilityHarness?: {
    createEditor: typeof createEditor;
    handleImagePaste: typeof handleImagePaste;
    handleSavedImagePath: typeof handleSavedImagePath;
    initializeImageHandling: typeof initializeImageHandling;
    setImageSrcResolver: typeof setImageSrcResolver;
    replaceLocalLinkStatuses: typeof replaceLocalLinkStatuses;
    getLocalLinkStatus: typeof getLocalLinkStatus;
    resolveInlineSourceOffsetAtPoint: typeof resolveInlineSourceOffsetAtPoint;
  };
}).TableStabilityHarness = {
  createEditor,
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver,
  replaceLocalLinkStatuses,
  getLocalLinkStatus,
  resolveInlineSourceOffsetAtPoint
};
