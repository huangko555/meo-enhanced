import { open } from 'node:fs/promises';
import { imageSize } from 'image-size';
import { IMAGE_INTRINSIC_SIZE_LIMIT, isImageDimension, type ImageIntrinsicSize } from '../foundation/imageDimensions';

const MAX_HEADER_BYTES = 65_536;
const MAX_CONCURRENT_READS = 4;

/** Reads bounded local headers during webview startup; never decodes pixels. */
export function createImageDimensionCatalog(sources: readonly { src: string; filePath: string }[]) {
  const entries: ImageIntrinsicSize[] = [];
  const files = new Map<string, string[]>();
  let aliases = 0;
  for (const { src, filePath } of sources) {
    if (!src.trim() || src.length > 16_384) continue;
    if (aliases >= IMAGE_INTRINSIC_SIZE_LIMIT) break;
    const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    const existing = files.get(key);
    if (existing?.includes(src)) continue;
    if (existing) existing.push(src); else files.set(key, [src]);
    aliases++;
  }
  const jobs = [...files.entries()];
  let next = 0;
  let disposed = false;
  const readNext = async () => {
    while (!disposed && next < jobs.length) {
      const [filePath, rawSources] = jobs[next++]!;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(filePath, 'r');
        const header = Buffer.allocUnsafe(MAX_HEADER_BYTES);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        const size = imageSize(header.subarray(0, bytesRead));
        // Browser naturalWidth/naturalHeight include EXIF orientation.
        const rotated = size.orientation !== undefined && size.orientation >= 5 && size.orientation <= 8;
        const width = rotated ? size.height : size.width, height = rotated ? size.width : size.height;
        if (!disposed && isImageDimension(width) && isImageDimension(height)) {
          for (const src of rawSources) entries.push({ src, width, height });
        }
      } catch {
        // Missing, unsupported, remote and truncated headers retain normal loading.
      } finally {
        await file?.close().catch(() => undefined);
      }
    }
  };
  const ready = Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_READS, jobs.length) }, readNext)).then(() => undefined);
  return {
    snapshot: (): readonly ImageIntrinsicSize[] => entries.slice(),
    ready,
    dispose() { disposed = true; entries.length = 0; }
  };
}
