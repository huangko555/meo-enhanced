import {
  createMermaidDiagramPresentationApplication,
  type MermaidDiagramPresentationEffect,
  type MermaidDiagramPresentationInput
} from '../webview/src/application/mermaidDiagramPresentation';

type Candidate = {
  present(source: string, themeKey: string, configKey: string): number;
  complete(input: MermaidDiagramPresentationInput): void;
  externalDocumentPresented(): void;
  dispose(): void;
  state(): ReturnType<ReturnType<typeof createMermaidDiagramPresentationApplication>['getState']>;
  effects(): readonly MermaidDiagramPresentationEffect[];
};

function createCandidate(root: HTMLElement): Candidate {
  const application = createMermaidDiagramPresentationApplication();
  const effectLog: MermaidDiagramPresentationEffect[] = [];

  const apply = (effects: readonly MermaidDiagramPresentationEffect[]): void => {
    for (const effect of effects) {
      effectLog.push(effect);
      if (effect.type === 'showPending') {
        const pending = document.createElement('div');
        pending.className = 'candidate-mermaid-pending';
        pending.textContent = 'Loading...';
        root.replaceChildren(pending);
      } else if (effect.type === 'showDiagram') {
        const diagram = document.createElement('div');
        diagram.className = 'candidate-mermaid-diagram';
        diagram.innerHTML = effect.svg;
        root.replaceChildren(diagram);
      } else if (effect.type === 'showError') {
        const error = document.createElement('div');
        error.className = 'candidate-mermaid-error';
        error.textContent = effect.error;
        root.replaceChildren(error);
      }
    }
  };

  return {
    present(source, themeKey, configKey) {
      apply(application.dispatch({ type: 'present', source, themeKey, configKey }));
      return application.getState().presentationId!;
    },
    complete(input) {
      apply(application.dispatch(input));
    },
    externalDocumentPresented() {
      apply(application.dispatch({ type: 'externalDocumentPresented' }));
      root.replaceChildren();
    },
    dispose() {
      apply(application.dispatch({ type: 'dispose' }));
      root.replaceChildren();
    },
    state: () => application.getState(),
    effects: () => effectLog
  };
}

(globalThis as typeof globalThis & {
  MermaidDiagramPresentationCandidate?: { create: typeof createCandidate };
}).MermaidDiagramPresentationCandidate = { create: createCandidate };
