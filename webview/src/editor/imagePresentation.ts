export type ImagePresentationView = {
  showFallback(sourceKey: string): boolean;
  showImage(image: HTMLImageElement): boolean;
  preserveLayoutChange(apply: () => boolean): boolean | Promise<boolean>;
  isVisible?(): boolean;
};

export type ImagePresentationHandle = {
  present(sourceKey: string, rawSrc: string): void;
  refresh(): Promise<void>;
  externalDocumentPresented(): void;
  whenCurrentPresentationSettles(signal?: AbortSignal): Promise<void>;
  dispose(): void;
};

/** Editor-internal seam consumed by image widgets without concrete runtime knowledge. */
export type ImagePresentationFactory = {
  /** Keeps shared image resource work active until the returned release is called. */
  acquire(): () => void;
  preload(rawSrc: string): Promise<void>;
  create(view: ImagePresentationView): ImagePresentationHandle;
  whenVisiblePresentationsSettle(signal?: AbortSignal): Promise<void>;
  externalDocumentPresented(): void;
  dispose(): void;
};

export const imagePresentationFactoryFacet = Facet.define<
  ImagePresentationFactory,
  ImagePresentationFactory | null
>({
  combine(values) {
    return values[0] ?? null;
  }
});

export function getImagePresentationFactory(state: EditorState): ImagePresentationFactory {
  const factory = state.facet(imagePresentationFactoryFacet);
  if (!factory) throw new Error('Image presentation factory is not installed');
  return factory;
}
import { Facet, type EditorState } from '@codemirror/state';
