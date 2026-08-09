export type ImagePresentationView = {
  showFallback(sourceKey: string): void;
  showImage(image: HTMLImageElement): void;
  preserveLayoutChange(apply: () => void): void;
};

export type ImagePresentationHandle = {
  present(sourceKey: string, rawSrc: string): void;
  externalDocumentPresented(): void;
  whenIdle(): Promise<void>;
  dispose(): void;
};

/** Editor-internal seam consumed by image widgets without concrete runtime knowledge. */
export type ImagePresentationFactory = {
  preload(rawSrc: string): Promise<void>;
  create(view: ImagePresentationView): ImagePresentationHandle;
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
