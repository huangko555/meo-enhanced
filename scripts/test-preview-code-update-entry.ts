import { createPreviewController } from '../webview/src/helpers/preview';
import { writePreviewFrame } from '../webview/src/helpers/previewFrameWriter';
import { createCodePaletteWebviewAdapter } from '../webview/src/adapters/codePaletteWebviewAdapter';
import { setShikiTheme } from '../webview/src/helpers/shikiHighlighter';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import { initializeMermaidEditorRuntime, renderMermaidRuntime } from '../webview/src/helpers/mermaidDiagram';
import { createPreviewScrollRange } from '../webview/src/helpers/previewScrollRange';
import { createPreviewViewport } from '../webview/src/helpers/previewViewport';

// Resolving both export palettes must not change the active Preview theme.
const palette = createCodePaletteWebviewAdapter({ setShikiTheme() {} });
const messages: unknown[] = [];
const controller = createPreviewController({
  vscode: { postMessage(message) { messages.push(message); scope.__previewHostMessage?.(message); } },
  uiLanguage: 'en',
  getEditorAppearance: () => 'dark',
  getCodePalette: appearance => palette.resolve(undefined, appearance).preview,
  applyCodeTheme: appearance => setShikiTheme(palette.resolve(undefined, appearance).sourceTheme, 'preview'),
  mermaidRenderResources: createMermaidDiagramRenderPool({
    initialize: initializeMermaidEditorRuntime,
    render: renderMermaidRuntime
  }),
  onViewportInteraction() { scope.__previewInteractionCount = (scope.__previewInteractionCount ?? 0) + 1; },
  onRendered() { scope.__previewRenderedAt = performance.now(); scope.__previewRenderProbe?.(); }
});
const scope = window as typeof window & {
  __previewController: typeof controller;
  __previewMessages: unknown[];
  __previewRenderedAt?: number;
  __previewRenderProbe?: () => void;
  __previewHostMessage?: (message: unknown) => void;
  __writePreviewFrame: typeof writePreviewFrame;
  __previewInteractionCount?: number;
  __createPreviewScrollRange: typeof createPreviewScrollRange;
  __createPreviewViewport: typeof createPreviewViewport;
};
scope.__previewController = controller;
scope.__previewMessages = messages;
scope.__writePreviewFrame = writePreviewFrame;
scope.__createPreviewScrollRange = createPreviewScrollRange;
scope.__createPreviewViewport = createPreviewViewport;
document.body.append(controller.host);
