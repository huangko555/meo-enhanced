import type {
  MermaidDiagramPresentationEffect,
  MermaidDiagramPresentationEffectExecution,
  MermaidDiagramPresentationEffectExecutor
} from '../application/mermaidDiagramPresentation';
import type { MermaidDiagramRenderPool } from './mermaidDiagramRenderPool';

export type MermaidDiagramPresentationAdapterOptions = {
  readonly body: HTMLElement;
  readonly pool: MermaidDiagramRenderPool;
  readonly normalizeSource: (source: string) => string;
  readonly preserveLayoutChange: (apply: () => void) => void;
};

/** Projects one Widget presentation while the Application owns correlation and phase. */
export function createMermaidDiagramPresentationEffectAdapter(
  options: MermaidDiagramPresentationAdapterOptions
): MermaidDiagramPresentationEffectExecutor {
  const { body, pool, normalizeSource, preserveLayoutChange } = options;
  let disposed = false;

  const replace = (...nodes: Node[]): void => {
    if (disposed) return;
    preserveLayoutChange(() => {
      if (!disposed) body.replaceChildren(...nodes);
    });
  };

  const showPending = (): void => {
    const pending = body.ownerDocument.createElement('div');
    pending.className = 'meo-mermaid-loading';
    pending.textContent = 'Loading...';
    replace(pending);
  };

  const showDiagram = (svg: string): void => {
    const wrapper = body.ownerDocument.createElement('div');
    wrapper.className = 'meo-mermaid-svg-wrapper';
    wrapper.innerHTML = svg;
    replace(wrapper);
  };

  const showError = (source: string, error: string): void => {
    const fallback = body.ownerDocument.createElement('pre');
    fallback.className = 'meo-mermaid-fallback';
    const code = body.ownerDocument.createElement('code');
    code.textContent = source;
    fallback.appendChild(code);
    const badge = body.ownerDocument.createElement('div');
    badge.className = 'meo-mermaid-error-badge';
    badge.textContent = `Mermaid error: ${error}`;
    replace(fallback, badge);
  };

  const execute = (
    effect: MermaidDiagramPresentationEffect
  ): MermaidDiagramPresentationEffectExecution => {
    if (disposed) return {};
    switch (effect.type) {
      case 'showPending':
        showPending();
        return {};
      case 'renderDiagram':
        return {
          completion: pool.render({
            rawSource: effect.source,
            normalizedSource: normalizeSource(effect.source),
            themeKey: effect.themeKey,
            configKey: effect.configKey
          }).then((result) => {
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
        showDiagram(effect.svg);
        return {};
      case 'clearPresentation':
        replace();
        return {};
      case 'showError':
        showError(effect.source, effect.error);
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
