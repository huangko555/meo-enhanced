/** Header dimensions are hints; the browser's decoded dimensions take priority. */
export type ImageIntrinsicSize = {
  readonly src: string;
  readonly width: number;
  readonly height: number;
};

export const IMAGE_INTRINSIC_SIZE_LIMIT = 512;

export function isImageDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
}

/** Markdown renderers encode destinations; local file resolution decodes once. */
export function imageDimensionSourceKey(src: string): string {
  try { return decodeURIComponent(src.trim()); } catch { return src.trim(); }
}
