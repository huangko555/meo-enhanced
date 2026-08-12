import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import {
  FrameObservationTimeoutError,
  assertAtMostOneAdjustment,
  assertNoDirectionReversal,
  observeContinuousFrames,
  type ProductFrameSample
} from './product-frame-observation';

const queuedFrames: FrameRequestCallback[] = [];
let timestamp = 0;
const requestFrame = (callback: FrameRequestCallback): number => {
  queuedFrames.push(callback);
  return queuedFrames.length;
};
const flushFrame = (): void => {
  timestamp += 16;
  const callback = queuedFrames.shift();
  if (!callback) throw new Error('Expected a queued animation frame');
  callback(timestamp);
};

let viewportOffset = 40;
const sample = (): ProductFrameSample => ({
  anchor: {
    key: 'paragraph:shipping',
    documentPosition: 240,
    viewportOffset
  },
  metrics: {
    tableWidth: 640
  }
});

const tracePromise = observeContinuousFrames(sample, {
  requestFrame,
  trigger: () => {
    viewportOffset = 32;
  },
  stableFrameCount: 2,
  maxFrameCount: 8,
  tolerance: 0.01
});
flushFrame();
await Promise.resolve();
viewportOffset = 28;
flushFrame();
await Promise.resolve();
flushFrame();
await Promise.resolve();
flushFrame();

const trace = await tracePromise;
assert.equal(trace.samples.length, 5);
assert.deepEqual(trace.samples.map((entry) => entry.anchor?.viewportOffset), [40, 32, 28, 28, 28]);
assertNoDirectionReversal(trace, (entry) => entry.anchor?.viewportOffset ?? 0, 0.01);

assert.doesNotThrow(() => assertAtMostOneAdjustment({
  samples: [
    { frame: 0, timestamp: 0, anchor: null, metrics: { width: 100 } },
    { frame: 1, timestamp: 16, anchor: null, metrics: { width: 120 } },
    { frame: 2, timestamp: 32, anchor: null, metrics: { width: 120 } }
  ]
}, (entry) => entry.metrics.width, 0.01));

assert.throws(
  () => assertAtMostOneAdjustment({
    samples: [
      { frame: 0, timestamp: 0, anchor: null, metrics: { width: 100 } },
      { frame: 1, timestamp: 16, anchor: null, metrics: { width: 110 } },
      { frame: 2, timestamp: 32, anchor: null, metrics: { width: 120 } }
    ]
  }, (entry) => entry.metrics.width, 0.01),
  /adjusted more than once/
);

assert.throws(
  () => assertNoDirectionReversal({
    samples: [
      { frame: 0, timestamp: 0, anchor: null, metrics: { width: 100 } },
      { frame: 1, timestamp: 16, anchor: null, metrics: { width: 130 } },
      { frame: 2, timestamp: 32, anchor: null, metrics: { width: 118 } }
    ]
  }, (entry) => entry.metrics.width, 0.01),
  /reversed direction/
);

let changingPosition = 1;
const unstablePromise = observeContinuousFrames(() => ({
  anchor: {
    key: 'line:1',
    documentPosition: changingPosition++,
    viewportOffset: 0
  },
  metrics: {}
}), {
  requestFrame,
  stableFrameCount: 2,
  maxFrameCount: 2
});
flushFrame();
await Promise.resolve();
flushFrame();
await assert.rejects(unstablePromise, (error: unknown) => {
  assert.ok(error instanceof FrameObservationTimeoutError);
  assert.equal(error.trace.samples.length, 3);
  assert.match(error.message, /did not become semantically stable within 2 frames/);
  return true;
});

await assert.rejects(
  observeContinuousFrames(sample, {
    requestFrame,
    stableFrameCount: 3,
    maxFrameCount: 2
  }),
  /maxFrameCount must be greater than or equal to stableFrameCount/
);

console.log('Product continuous-frame observation contract passed.');

if (process.argv.includes('--browser')) {
  const repoRoot = path.resolve(import.meta.dir, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-frame-observation-'));
  try {
    const entryPath = path.join(tempDir, 'entry.ts');
    fs.writeFileSync(entryPath, [
      `import * as observation from ${JSON.stringify(path.join(repoRoot, 'scripts', 'product-frame-observation').replaceAll('\\', '/'))};`,
      '(globalThis as any).ProductFrameObservation = observation;'
    ].join('\n'));
    const build = await Bun.build({
      entrypoints: [entryPath],
      outdir: tempDir,
      target: 'browser',
      format: 'iife',
      naming: 'bundle.js'
    });
    if (!build.success) throw new Error(build.logs.map(String).join('\n'));

    const browser = await launchTestBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html>
        <style>
          #viewport { box-sizing: border-box; height: 240px; overflow: auto; padding-top: 48px; }
          #anchor { width: 320px; height: 24px; margin: 0; }
        </style>
        <main id="viewport">
          <p id="anchor" data-anchor-key="paragraph:shipping" data-document-position="240">Shipping</p>
        </main>`);
      await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

      const result = await page.evaluate(async () => {
        const observation = (window as any).ProductFrameObservation;
        const viewport = document.querySelector<HTMLElement>('#viewport')!;
        const anchor = document.querySelector<HTMLElement>('#anchor')!;
        const trace = await observation.observeContinuousFrames(() => {
          const viewportRect = viewport.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          return {
            anchor: {
              key: anchor.dataset.anchorKey!,
              documentPosition: Number(anchor.dataset.documentPosition),
              viewportOffset: anchorRect.top - viewportRect.top
            },
            metrics: { anchorWidth: anchorRect.width }
          };
        }, {
          trigger: () => {
            viewport.style.paddingTop = '32px';
          },
          stableFrameCount: 2,
          maxFrameCount: 12,
          tolerance: 0.01
        });
        observation.assertNoDirectionReversal(trace, (sample: any) => sample.anchor.viewportOffset, 0.01);
        observation.assertAtMostOneAdjustment(trace, (sample: any) => sample.anchor.viewportOffset, 0.01);
        return {
          offsets: trace.samples.map((sample: any) => sample.anchor.viewportOffset),
          timestamps: trace.samples.map((sample: any) => sample.timestamp)
        };
      });

      assert.equal(result.offsets[0], 48);
      assert.equal(result.offsets.at(-1), 32);
      assert.ok(result.offsets.length >= 4, `Expected a continuous stable trace, got ${JSON.stringify(result.offsets)}`);
      assert.ok(result.timestamps.every((value, index) => index === 0 || value >= result.timestamps[index - 1]!));
      console.log('Product continuous-frame observation Chromium smoke passed.');
    } finally {
      await browser.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
