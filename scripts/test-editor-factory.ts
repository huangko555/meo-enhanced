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
import darkPlus from '@shikijs/themes/dark-plus';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';
import { isShikiThemeReady, setShikiTheme } from '../webview/src/helpers/shikiHighlighter';

const resources = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
const factory = createMermaidDiagramPresentationFactory({
  resources,
  createHandle(view, consumer) {
    const application = createMermaidDiagramPresentationApplication();
    const executor = createMermaidDiagramPresentationEffectAdapter({
      view,
      resources: consumer,
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

type ProductionOptions = Parameters<typeof createProductionEditor>[0];
type TestEditorOptions = Omit<ProductionOptions, 'onApplyTransaction'> & {
  onApplyChanges?: (text: string) => void;
  onApplyTransaction?: ProductionOptions['onApplyTransaction'];
};

export function createEditor(options: TestEditorOptions) {
  // Standalone browser fixtures bypass the webview bootstrap. Initialize its
  // native UI and Source surfaces without overwriting a fixture's explicit theme.
  if (!document.documentElement.style.getPropertyValue('--meo-ui-surface')) {
    const light = document.documentElement.dataset.editorAppearance === 'light'
      || document.body.classList.contains('vscode-light');
    applyUiTheme(light ? 'light' : 'dark', true);
  }
  if (!isShikiThemeReady('source')) setShikiTheme(darkPlus, 'source');
  return createProductionEditor({
    ...options,
    onApplyTransaction: options.onApplyTransaction ?? (edit => options.onApplyChanges?.(edit.after.toString())),
    mermaidDiagramPresentationFactory: factory
  });
}

export function refreshMermaidTheme(): void {
  resources.refreshTheme();
}
