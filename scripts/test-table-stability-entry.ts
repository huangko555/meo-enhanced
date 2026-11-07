import { createEditor } from './test-editor-factory';
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver
} from '../webview/src/helpers/images';
import { getLocalLinkStatus, replaceLocalLinkStatuses } from '../webview/src/helpers/localLinks';
import { resolveInlineSourceOffsetAtPoint } from '../webview/src/helpers/inlinePresentation';
import {
  getTableTransactionProvenanceSnapshot
} from '../webview/src/adapters/tableTransactionProvenance';
import { createTableCommandTargetRegistry } from '../webview/src/editor/tableCommandTargetRegistry';
import { installCausalFrameSettlement } from './causal-frame-settlement';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { createWidgetRemountProbe } from './widget-remount-test-helpers';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';

const getTableProvenanceSnapshot = () => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor')!);
  const snapshot = getTableTransactionProvenanceSnapshot(view.state);
  return {
    lifecycle: snapshot.lifecycle,
    inserted: snapshot.insertedRows,
    deleted: snapshot.deletedRows
  };
};

(globalThis as typeof globalThis & {
  TableStabilityHarness?: {
    usesLargeDocumentDerivedWorkBudget: typeof usesLargeDocumentDerivedWorkBudget;
    applyUiTheme: typeof applyUiTheme;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
    createEditor: typeof createEditor;
    createWidgetRemountProbe: typeof createWidgetRemountProbe;
    handleImagePaste: typeof handleImagePaste;
    handleSavedImagePath: typeof handleSavedImagePath;
    initializeImageHandling: typeof initializeImageHandling;
    setImageSrcResolver: typeof setImageSrcResolver;
    replaceLocalLinkStatuses: typeof replaceLocalLinkStatuses;
    getLocalLinkStatus: typeof getLocalLinkStatus;
    resolveInlineSourceOffsetAtPoint: typeof resolveInlineSourceOffsetAtPoint;
    addToHistoryAnnotation: (value: boolean) => ReturnType<typeof Transaction.addToHistory.of>;
    getTableProvenanceSnapshot: typeof getTableProvenanceSnapshot;
    installCausalFrameSettlement: typeof installCausalFrameSettlement;
    createTableCommandTargetRegistry: typeof createTableCommandTargetRegistry;
  };
}).TableStabilityHarness = {
  usesLargeDocumentDerivedWorkBudget,
  applyUiTheme,
  applyBuiltInVisualBaseline,
  createEditor,
  createWidgetRemountProbe,
  handleImagePaste,
  handleSavedImagePath,
  initializeImageHandling,
  setImageSrcResolver,
  replaceLocalLinkStatuses,
  getLocalLinkStatus,
  resolveInlineSourceOffsetAtPoint,
  addToHistoryAnnotation: (value: boolean) => Transaction.addToHistory.of(value),
  getTableProvenanceSnapshot,
  installCausalFrameSettlement,
  createTableCommandTargetRegistry
};
