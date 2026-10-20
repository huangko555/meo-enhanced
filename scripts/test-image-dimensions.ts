import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImageDimensionCatalog } from '../src/host/imageDimensions';
import { decodeHostToWebviewMessage } from '../src/protocol/messages';
import { decodeImageIntrinsicSizes } from '../src/protocol/imageDimensions';
import { IMAGE_INTRINSIC_SIZE_LIMIT } from '../src/foundation/imageDimensions';

const temp = await mkdtemp(path.join(os.tmpdir(), 'meo-image-dimensions-'));
try {
  const filePath = path.join(temp, 'picture.svg');
  await writeFile(filePath, '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>');
  await writeFile(path.join(temp, 'invalid.png'), 'invalid');
  const catalog = createImageDimensionCatalog([
    { src: './picture.svg', filePath }, { src: 'picture.svg', filePath }, { src: './picture.svg', filePath },
    { src: 'missing.png', filePath: path.join(temp, 'missing.png') },
    { src: 'invalid.png', filePath: path.join(temp, 'invalid.png') }
  ]);
  assert.deepEqual(catalog.snapshot(), [], 'header reads must not block synchronous editor creation');
  await catalog.ready;
  const entries = catalog.snapshot();
  assert.deepEqual([...entries].sort((a, b) => a.src.localeCompare(b.src)), [
    { src: './picture.svg', width: 640, height: 360 }, { src: 'picture.svg', width: 640, height: 360 }
  ]);
  assert.deepEqual(decodeHostToWebviewMessage({ type: 'imageIntrinsicSizes', documentId: 'fixture', entries }),
    { type: 'imageIntrinsicSizes', documentId: 'fixture', entries });
  for (const entry of [{ src: '', width: 640, height: 360 }, { src: 'x', width: Infinity, height: 1 },
    { src: 'x', width: -1, height: 1 }, { src: 'x', width: 1.5, height: 1 }, { src: 'x', width: 1, height: 0 }]) {
    assert.equal(decodeImageIntrinsicSizes([entry]), null);
  }
  assert.equal(decodeHostToWebviewMessage({ type: 'imageIntrinsicSizes', documentId: '', entries }), null);
  assert.equal(decodeImageIntrinsicSizes(Array.from({ length: IMAGE_INTRINSIC_SIZE_LIMIT + 1 }, () => entries[0])), null);
  const bounded = createImageDimensionCatalog(Array.from({ length: IMAGE_INTRINSIC_SIZE_LIMIT + 1 }, (_, index) => ({ src: `${index}.svg`, filePath })));
  await bounded.ready;
  assert.equal(bounded.snapshot().length, IMAGE_INTRINSIC_SIZE_LIMIT);
  bounded.dispose();
  const canceled = createImageDimensionCatalog([{ src: 'canceled.svg', filePath }]);
  canceled.dispose();
  await canceled.ready;
  assert.deepEqual(canceled.snapshot(), [], 'late reads cannot publish after disposal');
  catalog.dispose();
  assert.deepEqual(catalog.snapshot(), []);
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log('bounded image header catalog and protocol checks passed');
