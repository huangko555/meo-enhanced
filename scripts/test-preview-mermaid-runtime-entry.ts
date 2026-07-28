import { createPreviewController } from '../webview/src/helpers/preview';
import {
  loadMermaidRuntime,
  MermaidDiagramWidget,
  runExclusiveMermaidOperation
} from '../webview/src/helpers/mermaidDiagram';

const previewMessages: unknown[] = [];
const controller = createPreviewController({
  vscode: { postMessage(message) { previewMessages.push(message); } },
  onRendered: () => {
    (window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt = performance.now();
  }
});
document.body.append(controller.host);
(window as typeof window & { __previewController?: typeof controller }).__previewController = controller;
(window as typeof window & { __previewMessages?: unknown[] }).__previewMessages = previewMessages;
(window as typeof window & { __renderEditorMermaid?: (source: string) => HTMLElement }).__renderEditorMermaid = (source) => {
  const editor = document.createElement('div');
  editor.className = 'cm-editor meo-mode-live';
  const content = document.createElement('div');
  content.className = 'cm-content';
  const line = document.createElement('div');
  line.className = 'cm-line';
  editor.appendChild(content);
  document.body.appendChild(editor);
  const widget = new MermaidDiagramWidget(source, 1, 4);
  const diagram = widget.toDOM();
  line.appendChild(diagram);
  content.appendChild(line);
  return diagram;
};
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
