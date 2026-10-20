import { IMAGE_INTRINSIC_SIZE_LIMIT, isImageDimension, type ImageIntrinsicSize } from '../foundation/imageDimensions';

export type ImageIntrinsicSizesEvent = {
  readonly type: 'imageIntrinsicSizes';
  readonly documentId: string;
  readonly entries: readonly ImageIntrinsicSize[];
};

export function decodeImageIntrinsicSizes(value: unknown): readonly ImageIntrinsicSize[] | null {
  if (!Array.isArray(value) || value.length > IMAGE_INTRINSIC_SIZE_LIMIT) return null;
  const entries: ImageIntrinsicSize[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.src !== 'string' || !entry.src.trim()
      || entry.src.length > 16_384 || !isImageDimension(entry.width) || !isImageDimension(entry.height)) return null;
    entries.push({ src: entry.src, width: entry.width, height: entry.height });
  }
  return entries;
}

export function decodeImageIntrinsicSizesEvent(value: unknown): ImageIntrinsicSizesEvent | null {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'imageIntrinsicSizes'
    || !('documentId' in value) || typeof value.documentId !== 'string' || !value.documentId
    || !('entries' in value)) return null;
  const entries = decodeImageIntrinsicSizes(value.entries);
  return entries === null ? null : { type: 'imageIntrinsicSizes', documentId: value.documentId, entries };
}
