import { createPreviewController } from '../webview/src/helpers/preview';
import { loadMermaidRuntime, runExclusiveMermaidOperation } from '../webview/src/helpers/mermaidDiagram';

const controller = createPreviewController({
  vscode: { postMessage() {} },
  onRendered: () => {
    (window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt = performance.now();
  }
});
document.body.append(controller.host);
controller.setVisible(true);
(window as typeof window & { __previewController?: typeof controller }).__previewController = controller;
(window as typeof window & { __renderLiveMermaid?: () => Promise<string> }).__renderLiveMermaid = () =>
  runExclusiveMermaidOperation(async () => {
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
      void runExclusiveMermaidOperation(() => new Promise((resolve) => window.setTimeout(resolve, delayMs)));
    }
  };
