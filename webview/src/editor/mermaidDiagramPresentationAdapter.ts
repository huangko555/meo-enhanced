import {
  type MermaidDiagramPresentationEffect,
  type MermaidDiagramPresentationEffectExecution,
  type MermaidDiagramPresentationEffectExecutor
} from '../application/mermaidDiagramPresentation';
import type { MermaidDiagramLeafRenderConsumer } from '../application/mermaidDiagramRenderResources';
import type { MermaidDiagramPresentationView } from './mermaidDiagramPresentation';

export type MermaidDiagramPresentationAdapterOptions = {
  readonly view: MermaidDiagramPresentationView;
  readonly resources: MermaidDiagramLeafRenderConsumer;
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
          configKey: effect.configKey,
          priority: 'high' as const
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
            if (!result.ok && result.unavailable) return null;
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
