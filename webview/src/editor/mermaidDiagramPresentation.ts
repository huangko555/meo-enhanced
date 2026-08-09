import { Facet, type EditorState } from '@codemirror/state';
import type {
  MermaidDiagramRenderRequest,
  MermaidDiagramRenderResources,
  MermaidDiagramRenderResult
} from '../application/mermaidDiagramRenderResources';

export type MermaidDiagramPresentationView = {
  showPending(): void;
  showDiagram(svg: string): void;
  showError(source: string, error: string): void;
  clearPresentation(): void;
  preserveLayoutChange(apply: () => void): void;
};

export type MermaidDiagramPresentationHandle = {
  present(source: string, themeKey: string, configKey: string): void;
  externalDocumentPresented(): void;
  whenIdle(): Promise<void>;
  dispose(): void;
};

/** Editor-internal interface injected into Mermaid widgets by Bootstrap. */
export type MermaidDiagramPresentationFactory = {
  create(view: MermaidDiagramPresentationView): MermaidDiagramPresentationHandle;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  getHeight(key: string): number | null;
  rememberHeight(key: string, height: number): void;
  subscribeThemeRefresh(listener: () => void): () => void;
  externalDocumentPresented(): void;
  dispose(): void;
};

export type MermaidDiagramPresentationFactoryOptions = {
  readonly resources: MermaidDiagramRenderResources;
  readonly createHandle: (
    view: MermaidDiagramPresentationView
  ) => MermaidDiagramPresentationHandle;
};

/** Owns Widget handle registration while Bootstrap owns concrete assembly. */
export function createMermaidDiagramPresentationFactory(
  options: MermaidDiagramPresentationFactoryOptions
): MermaidDiagramPresentationFactory {
  const handles = new Set<MermaidDiagramPresentationHandle>();
  let disposed = false;

  return {
    create(view) {
      if (disposed) throw new Error('Mermaid diagram presentation factory is disposed');
      const delegate = options.createHandle(view);
      let active = true;
      const handle: MermaidDiagramPresentationHandle = {
        present(source, themeKey, configKey) {
          if (active) delegate.present(source, themeKey, configKey);
        },
        externalDocumentPresented() {
          if (active) delegate.externalDocumentPresented();
        },
        whenIdle: () => active ? delegate.whenIdle() : Promise.resolve(),
        dispose() {
          if (!active) return;
          active = false;
          handles.delete(handle);
          delegate.dispose();
        }
      };
      handles.add(handle);
      return handle;
    },
    getCached: (request) => options.resources.getCached(request),
    getHeight: (key) => options.resources.getHeight(key),
    rememberHeight: (key, height) => options.resources.rememberHeight(key, height),
    subscribeThemeRefresh: (listener) => options.resources.subscribeThemeRefresh(listener),
    externalDocumentPresented() {
      for (const handle of [...handles]) handle.externalDocumentPresented();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of [...handles]) handle.dispose();
      handles.clear();
    }
  };
}

export const mermaidDiagramPresentationFactoryFacet = Facet.define<
  MermaidDiagramPresentationFactory,
  MermaidDiagramPresentationFactory | null
>({
  combine(values) {
    return values[0] ?? null;
  }
});

export function getMermaidDiagramPresentationFactory(
  state: EditorState
): MermaidDiagramPresentationFactory {
  const factory = state.facet(mermaidDiagramPresentationFactoryFacet);
  if (!factory) throw new Error('Mermaid diagram presentation factory is not installed');
  return factory;
}
