import { createMermaidDiagramPresentationApplication } from '../webview/src/application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from '../webview/src/adapters/mermaidDiagramPresentationRuntime';
import { createMermaidDiagramPresentationEffectAdapter } from '../webview/src/editor/mermaidDiagramPresentationAdapter';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';

type CandidateWidget = {
  present(source: string, themeKey?: string, configKey?: string): void;
  externalDocumentPresented(): void;
  whenIdle(): Promise<void>;
  state(): ReturnType<ReturnType<typeof createMermaidDiagramPresentationApplication>['getState']>;
  dispose(): void;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createEnvironment() {
  const events: string[] = [];
  let activeRenders = 0;
  let maxActiveRenders = 0;
  let applicationCount = 0;
  let runtimeCount = 0;
  let adapterCount = 0;
  const pool = createMermaidDiagramRenderPool({
    initialize(themeKey, configKey) {
      events.push(`initialize:${themeKey}:${configKey}`);
    },
    async render(_renderId, source) {
      activeRenders += 1;
      maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      events.push(`render:${source}`);
      await delay(source.includes('slow') ? 35 : 2);
      activeRenders -= 1;
      if (source.includes('invalid')) throw new Error('parse error');
      return `<svg data-source="${source}"><text>${source}</text></svg>`;
    }
  });

  const create = (root: HTMLElement): CandidateWidget => {
    const body = root.querySelector<HTMLElement>('[data-diagram-body]');
    if (!body) throw new Error('Candidate diagram body is required');
    const application = createMermaidDiagramPresentationApplication();
    applicationCount += 1;
    const adapter = createMermaidDiagramPresentationEffectAdapter({
      view: {
        showPending() {
          const pending = document.createElement('div');
          pending.className = 'meo-mermaid-loading';
          pending.textContent = 'Loading...';
          body.replaceChildren(pending);
        },
        showDiagram(svg) {
          const diagram = document.createElement('div');
          diagram.className = 'meo-mermaid-svg-wrapper';
          diagram.innerHTML = svg;
          body.replaceChildren(diagram);
        },
        showError(source, error) {
          const fallback = document.createElement('pre');
          fallback.className = 'meo-mermaid-fallback';
          fallback.textContent = source;
          const badge = document.createElement('div');
          badge.className = 'meo-mermaid-error-badge';
          badge.textContent = error;
          body.replaceChildren(fallback, badge);
        },
        clearPresentation: () => body.replaceChildren(),
        preserveLayoutChange(apply) {
          events.push('preserve-layout');
          apply();
        }
      },
      resources: pool,
      normalizeSource: (source) => source.trim(),
    });
    adapterCount += 1;
    const runtime = createMermaidDiagramPresentationRuntime({ application, executor: adapter });
    runtimeCount += 1;
    return {
      present(source, themeKey = 'light', configKey = 'default') {
        runtime.dispatch({ type: 'present', source, themeKey, configKey });
      },
      externalDocumentPresented() {
        runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenIdle: () => runtime.whenCurrentPresentationSettles(),
      state: () => application.getState(),
      dispose: () => runtime.dispose()
    };
  };

  return {
    create,
    runPreview(label: string) {
      return pool.runExclusive(async () => {
        events.push(`preview:${label}`);
        await delay(1);
        return label;
      }, 'high');
    },
    refreshTheme: () => pool.refreshTheme(),
    stats: () => ({
      events: [...events],
      maxActiveRenders,
      applicationCount,
      runtimeCount,
      adapterCount,
      poolCount: 1
    }),
    dispose: () => pool.dispose()
  };
}

(globalThis as typeof globalThis & {
  MermaidDiagramPresentationCandidate?: { createEnvironment: typeof createEnvironment };
}).MermaidDiagramPresentationCandidate = { createEnvironment };
