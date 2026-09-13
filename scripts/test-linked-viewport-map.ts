import assert from 'node:assert/strict';
import { createLinkedViewportMap } from '../webview/src/helpers/linkedViewportMap';

const map = createLinkedViewportMap([
  { source: 0, preview: 0 },
  { source: 400, preview: 400 },
  // A compact rendered block occupies far less Preview height than Source height.
  { source: 1200, preview: 460 },
  { source: 1800, preview: 1060 }
], { sourceMaximum: 1800, previewMaximum: 1060 });

const sourceSamples = Array.from({ length: 181 }, (_, index) => index * 10);
const previewSamples = sourceSamples.map(source => map.sourceToPreview(source));
assert.equal(previewSamples.some((value, index) => index > 0 && value < previewSamples[index - 1]), false);
assert.equal(map.sourceToPreview(400), 400);
assert.equal(map.sourceToPreview(800), 430);
assert.equal(map.sourceToPreview(1200), 460);
assert.equal(map.sourceToPreview(1800), 1060);

const previewInputSamples = Array.from({ length: 107 }, (_, index) => index * 10);
const sourceOutputSamples = previewInputSamples.map(preview => map.previewToSource(preview));
assert.equal(sourceOutputSamples.some((value, index) => index > 0 && value < sourceOutputSamples[index - 1]), false);
assert.ok(Math.abs(map.previewToSource(430) - 800) < 0.01);

const normalized = createLinkedViewportMap([
  { source: 0, preview: 0 },
  { source: 200, preview: 300 },
  { source: 200, preview: 260 },
  { source: 400, preview: 250 },
  { source: 600, preview: 600 }
], { sourceMaximum: 600, previewMaximum: 600 });
const normalizedSamples = Array.from({ length: 61 }, (_, index) => normalized.sourceToPreview(index * 10));
assert.equal(normalizedSamples.some((value, index) => index > 0 && value < normalizedSamples[index - 1]), false);

const rebased = createLinkedViewportMap([
  { source: 0, preview: 0 },
  { source: 500, preview: 700 },
  { source: 1000, preview: 1200 }
], { sourceMaximum: 1000, previewMaximum: 1200 }, { source: 500, preview: 640 });
assert.equal(rebased.sourceToPreview(500), 640);
assert.equal(rebased.previewToSource(640), 500);
const rebasedSamples = Array.from({ length: 101 }, (_, index) => rebased.sourceToPreview(index * 10));
assert.equal(rebasedSamples.some((value, index) => index > 0 && value < rebasedSamples[index - 1]), false);

console.log('Linked viewport map checks passed');
