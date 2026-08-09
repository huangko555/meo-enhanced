import { createEditor as createProductionEditor } from '../webview/src/editor';
import {
  initializeMermaidEditorRuntime,
  normalizeMermaidDiagramText,
  renderMermaidRuntime
} from '../webview/src/helpers/mermaidDiagram';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import { createMermaidDiagramPresentationApplication } from '../webview/src/application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from '../webview/src/adapters/mermaidDiagramPresentationRuntime';
import { createMermaidDiagramPresentationEffectAdapter } from '../webview/src/editor/mermaidDiagramPresentationAdapter';
import { createMermaidDiagramPresentationFactory } from '../webview/src/editor/mermaidDiagramPresentation';

const resources = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
const factory = createMermaidDiagramPresentationFactory({
  resources,
  createHandle(view) {
    const application = createMermaidDiagramPresentationApplication();
    const executor = createMermaidDiagramPresentationEffectAdapter({
      view,
      resources,
      normalizeSource: normalizeMermaidDiagramText
    });
    const runtime = createMermaidDiagramPresentationRuntime({ application, executor });
    return {
      present(source, themeKey, configKey) {
        runtime.dispatch({ type: 'present', source, themeKey, configKey });
      },
      externalDocumentPresented() {
        runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenIdle: () => runtime.whenCurrentPresentationSettles(),
      dispose: () => runtime.dispose()
    };
  }
});

export function createEditor(options: Parameters<typeof createProductionEditor>[0]) {
  return createProductionEditor({
    ...options,
    mermaidDiagramPresentationFactory: factory
  });
}

export function refreshMermaidTheme(): void {
  resources.refreshTheme();
}
