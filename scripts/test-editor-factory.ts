import { createEditor as createProductionEditor } from '../webview/src/editor';
import {
  initializeMermaidEditorRuntime,
  normalizeMermaidDiagramText,
  renderMermaidRuntime
} from '../webview/src/helpers/mermaidDiagram';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import { createMermaidDiagramPresentationFactory } from '../webview/src/editor/mermaidDiagramPresentationAdapter';

const resources = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
const factory = createMermaidDiagramPresentationFactory({
  resources,
  normalizeSource: normalizeMermaidDiagramText
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
