import { Facet, type EditorState } from '@codemirror/state';
import type {
  MermaidDiagramLeafRenderConsumer,
  MermaidDiagramRenderGroupLease,
  MermaidDiagramRenderRequest,
  MermaidDiagramRenderResources,
  MermaidDiagramRenderResult
} from '../application/mermaidDiagramRenderResources';

export type MermaidDiagramPresentationView = {
  hasDiagram?(): boolean;
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
  /** Warms one content-addressed SVG result without mounting diagram DOM. */
  preload(request: MermaidDiagramRenderRequest, signal?: AbortSignal): Promise<void>;
  getCached(request: MermaidDiagramRenderRequest): MermaidDiagramRenderResult | null;
  getStale(request: MermaidDiagramRenderRequest): Extract<MermaidDiagramRenderResult, { ok: true }> | null;
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
    resources: MermaidDiagramLeafRenderConsumer
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
      const preloadGroups = new Set<MermaidDiagramRenderGroupLease>();
      const releaseResourceLeases = new Set<() => void>();
      let activeGroup: MermaidDiagramRenderGroupLease | null = null;
      let consumerDisposed = false;
      const consumer: MermaidDiagramPresentationConsumer = {
        acquire() {
          if (consumerDisposed) throw new Error('Mermaid diagram presentation consumer is disposed');
          if (activeGroup) throw new Error('Mermaid diagram presentation consumer is already active');
          const group = options.resources.acquireGroup();
          activeGroup = group;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            releaseResourceLeases.delete(release);
            if (activeGroup === group) activeGroup = null;
            for (const warmGroup of preloadGroups) warmGroup.end();
            preloadGroups.clear();
            group.end();
          };
          releaseResourceLeases.add(release);
          return release;
        },
        create(view) {
          if (consumerDisposed) throw new Error('Mermaid diagram presentation consumer is disposed');
          if (!activeGroup) throw new Error('Mermaid diagram presentation consumer is not active');
          const resources = activeGroup.createLeaf();
          const delegate = options.createHandle(view, resources);
          let active = true;
          const handle: MermaidDiagramPresentationHandle = {
            present(source, themeKey, configKey) {
              if (!active) return;
              resources.replacePending();
              delegate.present(source, themeKey, configKey);
            },
            externalDocumentPresented() {
              if (!active) return;
              delegate.externalDocumentPresented();
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
        preload(request, signal) {
          if (consumerDisposed || !activeGroup || signal?.aborted || options.resources.getCached(request)) {
            return Promise.resolve();
          }
          // Warm-up has a cancellable lease of its own. Ending it must not
          // retire a visible Widget's waiter for the same shared render job.
          const group = options.resources.acquireGroup();
          preloadGroups.add(group);
          const resources = group.createLeaf();
          const cancel = () => { group.end(); };
          signal?.addEventListener('abort', cancel, { once: true });
          return resources.render({ ...request, priority: 'normal' })
            .then(() => undefined)
            .finally(() => {
              signal?.removeEventListener('abort', cancel);
              group.end();
              preloadGroups.delete(group);
            });
        },
        getCached: (request) => options.resources.getCached(request),
        getStale: (request) => options.resources.getStale(request),
        getHeight: (key) => options.resources.getHeight(key),
        rememberHeight: (key, height) => options.resources.rememberHeight(key, height),
        subscribeThemeRefresh: (listener) => options.resources.subscribeThemeRefresh(listener),
        externalDocumentPresented() {
          for (const group of preloadGroups) group.end();
          preloadGroups.clear();
          activeGroup?.replaceForExternalDocument();
          for (const handle of [...handles]) handle.externalDocumentPresented();
        },
        dispose() {
          if (consumerDisposed) return;
          consumerDisposed = true;
          for (const group of preloadGroups) group.end();
          preloadGroups.clear();
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
