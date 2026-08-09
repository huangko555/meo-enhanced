import {
  createMermaidDiagramPresentationApplication,
  type MermaidDiagramPresentationEffect,
  type MermaidDiagramPresentationEffectExecution,
  type MermaidDiagramPresentationEffectExecutor
} from '../application/mermaidDiagramPresentation';
import type { MermaidDiagramRenderResources } from '../application/mermaidDiagramRenderResources';
import { createMermaidDiagramPresentationRuntime } from '../adapters/mermaidDiagramPresentationRuntime';
import type {
  MermaidDiagramPresentationFactory,
  MermaidDiagramPresentationHandle,
  MermaidDiagramPresentationView
} from './mermaidDiagramPresentation';

export type MermaidDiagramPresentationAdapterOptions = {
  readonly view: MermaidDiagramPresentationView;
  readonly resources: MermaidDiagramRenderResources;
  readonly normalizeSource: (source: string) => string;
};

/** Projects one Widget presentation while the Application owns correlation and phase. */
export function createMermaidDiagramPresentationEffectAdapter(
  options: MermaidDiagramPresentationAdapterOptions
): MermaidDiagramPresentationEffectExecutor {
  const { view, resources, normalizeSource } = options;
  let disposed = false;

  const project = (apply: () => void): void => {
    if (disposed) return;
    view.preserveLayoutChange(() => {
      if (!disposed) apply();
    });
  };

  const execute = (
    effect: MermaidDiagramPresentationEffect
  ): MermaidDiagramPresentationEffectExecution => {
    if (disposed) return {};
    switch (effect.type) {
      case 'showPending':
        project(() => view.showPending());
        return {};
      case 'renderDiagram':
        const request = {
          rawSource: effect.source,
          normalizedSource: normalizeSource(effect.source),
          themeKey: effect.themeKey,
          configKey: effect.configKey
        };
        const cached = resources.getCached(request);
        if (cached) {
          return {
            immediate: 'error' in cached
              ? {
                  type: 'renderFailed',
                  presentationId: effect.presentationId,
                  error: cached.error
                }
              : {
                  type: 'renderSucceeded',
                  presentationId: effect.presentationId,
                  svg: cached.svg
                }
          };
        }
        return {
          completion: resources.render(request).then((result) => {
            if (!('error' in result)) {
              return {
                type: 'renderSucceeded' as const,
                presentationId: effect.presentationId,
                svg: result.svg
              };
            }
            return {
              type: 'renderFailed' as const,
              presentationId: effect.presentationId,
              error: result.error
            };
          })
        };
      case 'showDiagram':
        project(() => view.showDiagram(effect.svg));
        return {};
      case 'clearPresentation':
        project(() => view.clearPresentation());
        return {};
      case 'showError':
        project(() => view.showError(effect.source, effect.error));
        return {};
    }
  };

  return {
    execute,
    dispose() {
      disposed = true;
    }
  };
}

export type MermaidDiagramPresentationFactoryOptions = {
  readonly resources: MermaidDiagramRenderResources;
  readonly normalizeSource: (source: string) => string;
};

/** Creates exactly one Application/Runtime/Adapter tuple for each Mermaid Widget. */
export function createMermaidDiagramPresentationFactory(
  options: MermaidDiagramPresentationFactoryOptions
): MermaidDiagramPresentationFactory {
  const handles = new Set<MermaidDiagramPresentationHandle>();
  let disposed = false;

  const create = (view: MermaidDiagramPresentationView): MermaidDiagramPresentationHandle => {
    if (disposed) throw new Error('Mermaid diagram presentation factory is disposed');
    const application = createMermaidDiagramPresentationApplication();
    const executor = createMermaidDiagramPresentationEffectAdapter({
      view,
      resources: options.resources,
      normalizeSource: options.normalizeSource
    });
    const runtime = createMermaidDiagramPresentationRuntime({ application, executor });
    let active = true;
    const handle: MermaidDiagramPresentationHandle = {
      present(source, themeKey, configKey) {
        if (active) runtime.dispatch({ type: 'present', source, themeKey, configKey });
      },
      externalDocumentPresented() {
        if (active) runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenIdle: () => runtime.whenCurrentPresentationSettles(),
      dispose() {
        if (!active) return;
        active = false;
        handles.delete(handle);
        runtime.dispose();
      }
    };
    handles.add(handle);
    return handle;
  };

  return {
    create,
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
