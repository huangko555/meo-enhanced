import { createEditor } from './test-editor-factory';
import { flushMountedTableLayouts, refreshMountedTablePositions } from '../webview/src/helpers/tables';
import { getViewportController } from '../webview/src/helpers/viewportController';
import { renderMermaidRuntime } from '../webview/src/helpers/mermaidDiagram';
import { preloadMermaidDocumentBatch } from '../webview/src/helpers/mermaidDocumentPreloader';
import { requestShikiTokens, getShikiTokens, setShikiTheme } from '../webview/src/helpers/shikiHighlighter';
import { shikiRefreshEffect } from '../webview/src/helpers/shikiDecorations';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { getLivePresentationBand, isLiveViewportPresentationEffect } from '../webview/src/helpers/liveViewportPresentation';

(window as any).RenderedBlockScrollLayoutHarness = {
  createEditor, flushMountedTableLayouts, refreshMountedTablePositions, getViewportController,
  renderMermaidRuntime, preloadMermaidDocumentBatch,
  requestShikiTokens, getShikiTokens, setShikiTheme, shikiRefreshEffect, usesLargeDocumentDerivedWorkBudget,
  getLivePresentationBand, isLiveViewportPresentationEffect
};
