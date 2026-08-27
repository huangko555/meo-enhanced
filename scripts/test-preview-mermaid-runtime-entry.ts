import { createPreviewController } from '../webview/src/helpers/preview';
import { resolveFinalCodePalette } from '../webview/src/application/finalCodePalette';
import { createEditor } from '../webview/src/editor';
import {
  initializeMermaidEditorRuntime,
  loadMermaidRuntime,
  normalizeMermaidDiagramText,
  renderMermaidRuntime
} from '../webview/src/helpers/mermaidDiagram';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import type { MermaidDiagramRenderResources } from '../webview/src/application/mermaidDiagramRenderResources';
import { createMermaidDiagramPresentationApplication } from '../webview/src/application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from '../webview/src/adapters/mermaidDiagramPresentationRuntime';
import { createMermaidDiagramPresentationEffectAdapter } from '../webview/src/editor/mermaidDiagramPresentationAdapter';
import { createMermaidDiagramPresentationFactory } from '../webview/src/editor/mermaidDiagramPresentation';

const mermaidResources = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
const mermaidPresentationFactory = createMermaidDiagramPresentationFactory({
  resources: mermaidResources,
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

const previewMermaidResources: MermaidDiagramRenderResources = {
  ...mermaidResources,
  acquireGroup() {
    const consumer = mermaidResources.acquireGroup();
    return {
      ...consumer,
      runExclusive<T>(operation: () => Promise<T>, priority?: 'high' | 'normal') {
        const testWindow = window as typeof window & { __previewMermaidRequests?: number };
        testWindow.__previewMermaidRequests = (testWindow.__previewMermaidRequests ?? 0) + 1;
        return consumer.runExclusive(operation, priority);
      }
    };
  }
};

const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
  const consumer = mermaidResources.acquireGroup();
  try {
    return await consumer.runExclusive(operation);
  } finally {
    consumer.end();
  }
};

const previewMessages: unknown[] = [];
type SharedMermaidEditorOptions = Omit<
  Parameters<typeof createEditor>[0],
  'mermaidDiagramPresentationFactory'
>;
const controller = createPreviewController({
  vscode: { postMessage(message) { previewMessages.push(message); } },
  uiLanguage: 'en',
  getEditorAppearance: () => 'dark',
  getCodePalette: (appearance) => resolveFinalCodePalette(undefined, appearance).preview,
  mermaidRenderResources: previewMermaidResources,
  onRendered: () => {
    (window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt = performance.now();
  }
});
document.body.append(controller.host);
(window as typeof window & { __previewController?: typeof controller }).__previewController = controller;
(window as typeof window & { __previewMessages?: unknown[] }).__previewMessages = previewMessages;
(window as typeof window & {
  __createSharedMermaidEditor?: (options: SharedMermaidEditorOptions) => ReturnType<typeof createEditor>;
}).__createSharedMermaidEditor = (options) => createEditor({
  ...options,
  mermaidDiagramPresentationFactory: mermaidPresentationFactory
});
(window as typeof window & { __renderEditorMermaid?: (source: string) => HTMLElement }).__renderEditorMermaid = (source) => {
  const host = document.createElement('div');
  host.className = 'editor-host';
  document.body.appendChild(host);
  (window as typeof window & {
    __createSharedMermaidEditor?: (options: SharedMermaidEditorOptions) => ReturnType<typeof createEditor>;
  }).__createSharedMermaidEditor?.({
    parent: host,
    text: `\`\`\`mermaid\n${source}\n\`\`\``,
    initialMode: 'live',
    onApplyChanges() {}
  });
  return host;
};
(window as typeof window & { __renderLiveMermaid?: () => Promise<string> }).__renderLiveMermaid = () =>
  runExclusive(async () => {
    const mermaid = await loadMermaidRuntime();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: { darkMode: true, primaryColor: '#20252b', primaryTextColor: '#d8dee9' }
    });
    const result = await mermaid.render('meo-live-before-preview', 'flowchart LR\n  Live --> Preview');
    return result.svg;
  });
(window as typeof window & { __queueSlowLiveOperations?: (count: number, delayMs: number) => void })
  .__queueSlowLiveOperations = (count, delayMs) => {
    for (let index = 0; index < count; index += 1) {
      void runExclusive(() => new Promise((resolve) => window.setTimeout(resolve, delayMs)));
    }
  };
