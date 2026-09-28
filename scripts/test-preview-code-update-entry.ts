import { createPreviewController } from '../webview/src/helpers/preview';
import { createCodePaletteWebviewAdapter } from '../webview/src/adapters/codePaletteWebviewAdapter';
import { setShikiTheme } from '../webview/src/helpers/shikiHighlighter';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import { initializeMermaidEditorRuntime, renderMermaidRuntime } from '../webview/src/helpers/mermaidDiagram';

// Resolving both export palettes must not change the active Preview theme.
const palette = createCodePaletteWebviewAdapter({ setShikiTheme() {} });
const messages: unknown[] = [];
const controller = createPreviewController({
  vscode: { postMessage(message) { messages.push(message); } },
  uiLanguage: 'en',
  getEditorAppearance: () => 'dark',
  getCodePalette: appearance => palette.resolve(undefined, appearance).preview,
  applyCodeTheme: appearance => setShikiTheme(palette.resolve(undefined, appearance).sourceTheme, 'preview'),
  mermaidRenderResources: createMermaidDiagramRenderPool({
    initialize: initializeMermaidEditorRuntime,
    render: renderMermaidRuntime
  }),
  onRendered() { scope.__previewRenderedAt = performance.now(); }
});
const scope = window as typeof window & {
  __previewController: typeof controller;
  __previewMessages: unknown[];
  __previewRenderedAt?: number;
};
scope.__previewController = controller;
scope.__previewMessages = messages;
document.body.append(controller.host);