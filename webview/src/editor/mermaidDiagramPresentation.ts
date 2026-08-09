import { Facet, type EditorState } from '@codemirror/state';
import type {
  MermaidDiagramRenderRequest,
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
