import { createPreviewController } from '../webview/src/helpers/preview';
import { createEditor } from '../webview/src/editor';
import {
  initializeMermaidEditorRuntime,
  loadMermaidRuntime,
  normalizeMermaidDiagramText,
  renderMermaidRuntime
} from '../webview/src/helpers/mermaidDiagram';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import { createMermaidDiagramPresentationFactory } from '../webview/src/editor/mermaidDiagramPresentationAdapter';

const mermaidResources = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
const mermaidPresentationFactory = createMermaidDiagramPresentationFactory({
  resources: mermaidResources,
  normalizeSource: normalizeMermaidDiagramText
});

const previewMessages: unknown[] = [];
const controller = createPreviewController({
  vscode: { postMessage(message) { previewMessages.push(message); } },
  mermaidRenderResources: mermaidResources,
  onRendered: () => {
    (window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt = performance.now();
  }
});
document.body.append(controller.host);
(window as typeof window & { __previewController?: typeof controller }).__previewController = controller;
(window as typeof window & { __previewMessages?: unknown[] }).__previewMessages = previewMessages;
(window as typeof window & { __renderEditorMermaid?: (source: string) => HTMLElement }).__renderEditorMermaid = (source) => {
  const host = document.createElement('div');
  host.className = 'editor-host';
  document.body.appendChild(host);
  createEditor({
    parent: host,
    text: `\`\`\`mermaid\n${source}\n\`\`\``,
    initialMode: 'live',
    onApplyChanges() {},
    mermaidDiagramPresentationFactory: mermaidPresentationFactory
  });
  return host;
};
(window as typeof window & { __renderLiveMermaid?: () => Promise<string> }).__renderLiveMermaid = () =>
  mermaidResources.runExclusive(async () => {
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
      void mermaidResources.runExclusive(() => new Promise((resolve) => window.setTimeout(resolve, delayMs)));
    }
  };
