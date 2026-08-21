import { Facet, type EditorState } from '@codemirror/state';
import type {
  MermaidDiagramRenderConsumer,
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

/** Per-Editor consumer scope injected into Mermaid widgets by Editor Bootstrap. */
export type MermaidDiagramPresentationConsumer = {
  /** Keeps shared work reusable while this Editor remains in Live mode. */
  acquire(): () => void;
  create(view: MermaidDiagramPresentationView): MermaidDiagramPresentationHandle;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  getHeight(key: string): number | null;
  rememberHeight(key: string, height: number): void;
  subscribeThemeRefresh(listener: () => void): () => void;
  externalDocumentPresented(): void;
  dispose(): void;
};

/** Webview-wide owner that creates isolated per-Editor consumer scopes. */
export type MermaidDiagramPresentationFactory = {
  createConsumer(): MermaidDiagramPresentationConsumer;
  dispose(): void;
};

export type MermaidDiagramPresentationFactoryOptions = {
  readonly resources: MermaidDiagramRenderResources;
  readonly createHandle: (
    view: MermaidDiagramPresentationView,
    resources: MermaidDiagramRenderConsumer
  ) => MermaidDiagramPresentationHandle;
};

/** Owns per-Editor scopes while Bootstrap owns concrete runtime assembly. */
export function createMermaidDiagramPresentationFactory(
  options: MermaidDiagramPresentationFactoryOptions
): MermaidDiagramPresentationFactory {
  const consumers = new Set<MermaidDiagramPresentationConsumer>();
  let disposed = false;

  return {
    createConsumer() {
      if (disposed) throw new Error('Mermaid diagram presentation factory is disposed');
      const handles = new Set<MermaidDiagramPresentationHandle>();
      const releaseResourceLeases = new Set<() => void>();
      let activeResources: MermaidDiagramRenderConsumer | null = null;
      let consumerDisposed = false;
      const consumer: MermaidDiagramPresentationConsumer = {
        acquire() {
          if (consumerDisposed) return () => undefined;
          if (activeResources) throw new Error('Mermaid diagram presentation consumer is already active');
          const releasePoolLease = options.resources.acquire();
          activeResources = releasePoolLease;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            releaseResourceLeases.delete(release);
            if (activeResources === releasePoolLease) activeResources = null;
            releasePoolLease.release();
          };
          releaseResourceLeases.add(release);
          return release;
        },
        create(view) {
          if (consumerDisposed) throw new Error('Mermaid diagram presentation consumer is disposed');
          if (!activeResources) throw new Error('Mermaid diagram presentation consumer is not active');
          const resources = activeResources.fork();
          const delegate = options.createHandle(view, resources);
          let active = true;
          const handle: MermaidDiagramPresentationHandle = {
            present(source, themeKey, configKey) {
              if (!active) return;
              resources.invalidate();
              delegate.present(source, themeKey, configKey);
            },
            externalDocumentPresented() {
              if (!active) return;
              delegate.externalDocumentPresented();
              resources.invalidate();
            },
            whenIdle: () => active ? delegate.whenIdle() : Promise.resolve(),
            dispose() {
              if (!active) return;
              active = false;
              handles.delete(handle);
              delegate.dispose();
              resources.release();
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
          activeResources?.invalidate();
        },
        dispose() {
          if (consumerDisposed) return;
          consumerDisposed = true;
          for (const handle of [...handles]) handle.dispose();
          handles.clear();
          for (const release of [...releaseResourceLeases]) release();
          releaseResourceLeases.clear();
          consumers.delete(consumer);
        }
      };
      consumers.add(consumer);
      return consumer;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const consumer of [...consumers]) consumer.dispose();
      consumers.clear();
    }
  };
}

export const mermaidDiagramPresentationFactoryFacet = Facet.define<
  MermaidDiagramPresentationConsumer,
  MermaidDiagramPresentationConsumer | null
>({
  combine(values) {
    return values[0] ?? null;
  }
});

export function getMermaidDiagramPresentationFactory(
  state: EditorState
): MermaidDiagramPresentationConsumer {
  const factory = state.facet(mermaidDiagramPresentationFactoryFacet);
  if (!factory) throw new Error('Mermaid diagram presentation factory is not installed');
  return factory;
}
