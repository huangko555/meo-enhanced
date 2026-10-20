import { createPreviewController } from '../webview/src/helpers/preview';
import { createCodePaletteWebviewAdapter } from '../webview/src/adapters/codePaletteWebviewAdapter';
import { setShikiTheme } from '../webview/src/helpers/shikiHighlighter';
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
import { createPreviewMermaidRenderer } from '../webview/src/helpers/previewMermaid';

(window as typeof window & { __loadMermaidRuntime: typeof loadMermaidRuntime }).__loadMermaidRuntime = loadMermaidRuntime;

const mermaidResources = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
(window as any).__probePreviewGestureBatch = async () => {
  const runtime = await loadMermaidRuntime(), original = runtime.render;
  const frame = document.createElement('iframe'); frame.style.height = '400px'; document.body.append(frame);
  const doc = frame.contentDocument!; doc.documentElement.dataset.meoPreviewLargeDocument = 'true';
  doc.body.innerHTML = [0, 1].map(index => `<div class="meo-export-mermaid" style="height:100px" data-source-b64="${btoa(`flowchart LR; A[Gesture-${Date.now()}-${index}]-->B`)}"></div>`).join('');
  let interacting = false, started = 0, completed = 0, notices = 0;
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(() => new Promise<void>(resolve => releases.push(resolve)));
  runtime.render = (async (id: string) => {
    const index = started++; await gates[index]; completed++;
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 100 60"><rect width="100" height="60"/></svg>` };
  }) as typeof runtime.render;
  const renderer = createPreviewMermaidRenderer(mermaidResources, error => { throw error; }, () => interacting);
  const operation = renderer.render(doc, 'dark', () => notices++);
  const wait = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5_000;
    while (!predicate()) {
      if (performance.now() > deadline) throw Error('Gesture batch did not reach its boundary');
      await new Promise(requestAnimationFrame);
    }
  };
  const painted = () => doc.querySelectorAll('.meo-export-mermaid.is-rendered svg').length;
  try {
    await wait(() => started === 1);
    interacting = true; releases[0]!(); await wait(() => completed === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    const between = { started, painted: painted() };
    interacting = false; await wait(() => started === 2);
    interacting = true; releases[1]!(); await wait(() => completed === 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    const beforeCommit = { painted: painted(), notices };
    interacting = false; await operation;
    return { between, beforeCommit, after: { painted: painted(), notices } };
  } finally {
    interacting = false; for (const release of releases) release(); renderer.dispose();
    await operation.catch(() => {}); runtime.render = original; frame.remove();
  }
};
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

let previewRenderGate: Promise<void> | null = null;
(window as typeof window & { __holdPreviewMermaid?: () => void; __releasePreviewMermaid?: () => void })
  .__holdPreviewMermaid = () => {
    (window as typeof window & { __previewMermaidGateStarted?: boolean }).__previewMermaidGateStarted = false;
    previewRenderGate = new Promise<void>(resolve => {
      (window as typeof window & { __releasePreviewMermaid?: () => void }).__releasePreviewMermaid = () => {
        previewRenderGate = null;
        resolve();
      };
    });
  };
const previewMermaidResources: MermaidDiagramRenderResources = {
  ...mermaidResources,
  acquireGroup() {
    const consumer = mermaidResources.acquireGroup();
    return {
      ...consumer,
      runExclusive<T>(operation: () => Promise<T>, priority?: 'high' | 'normal') {
        const testWindow = window as typeof window & { __previewMermaidRequests?: number };
        testWindow.__previewMermaidRequests = (testWindow.__previewMermaidRequests ?? 0) + 1;
        const gate = previewRenderGate;
        if (!gate) return consumer.runExclusive(operation, priority);
        return consumer.runExclusive(async () => {
          (window as typeof window & { __previewMermaidGateStarted?: boolean }).__previewMermaidGateStarted = true;
          await gate;
          return operation();
        }, priority);
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

const codePaletteAdapter = createCodePaletteWebviewAdapter({
  setShikiTheme(theme) {
    setShikiTheme(theme, 'preview');
  }
});

const previewMessages: unknown[] = [];
type SharedMermaidEditorOptions = Omit<
  Parameters<typeof createEditor>[0],
  'mermaidDiagramPresentationFactory' | 'onApplyTransaction'
> & { onApplyChanges?: (text: string) => void };
const controller = createPreviewController({
  vscode: { postMessage(message) { previewMessages.push(message); } },
  uiLanguage: 'en',
  getEditorAppearance: () => 'dark',
  isCurrentText: (text: string) => {
    const current = (window as typeof window & { __previewCurrentText?: string }).__previewCurrentText;
    return current === undefined || current === text;
  },
  getCodePalette: (appearance) => codePaletteAdapter.resolve(undefined, appearance).preview,
  applyCodeTheme: (appearance) => {
    setShikiTheme(codePaletteAdapter.resolve(undefined, appearance).sourceTheme, 'preview');
  },
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
  onApplyTransaction: edit => options.onApplyChanges?.(edit.after.toString()),
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
(window as typeof window & { __probeInvalidMermaidCleanup?: () => Promise<boolean> })
  .__probeInvalidMermaidCleanup = async () => {
    try {
      await renderMermaidRuntime('meo-invalid-cleanup-probe', 'this is invalid mermaid');
    } catch {
      // Invalid syntax is expected; only leaked runtime DOM is under test.
    }
    return Boolean(
      document.getElementById('dmeo-invalid-cleanup-probe')
      || document.body.textContent?.includes('Syntax error in text')
    );
  };
(window as typeof window & { __queueSlowLiveOperations?: (count: number, delayMs: number) => void })
  .__queueSlowLiveOperations = (count, delayMs) => {
    for (let index = 0; index < count; index += 1) {
      void runExclusive(() => new Promise((resolve) => window.setTimeout(resolve, delayMs)));
    }
  };
