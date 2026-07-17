import { createEditor } from '../webview/src/editor';
import { Transaction } from '@codemirror/state';
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
    addToHistoryAnnotation: (value: boolean) => ReturnType<typeof Transaction.addToHistory.of>;
  };
}).TableStabilityHarness = {
  createEditor,
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver,
  replaceLocalLinkStatuses,
  getLocalLinkStatus,
  resolveInlineSourceOffsetAtPoint,
  addToHistoryAnnotation: (value: boolean) => Transaction.addToHistory.of(value)
};
