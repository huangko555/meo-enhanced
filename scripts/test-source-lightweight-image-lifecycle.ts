import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-source-image-lifecycle-'));

const waitForFrames = async (page: import('puppeteer-core').Page, count = 8): Promise<void> => {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
};

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-source-lightweight-image-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 760, deviceScaleFactor: 1 });
    await page.setContent([
      '<!doctype html><style>html,body{height:100%;margin:0}.host{height:48%;}</style>',
      '<div id="first" class="host"></div><div id="second" class="host"></div>'
    ].join(''));
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (!descriptor?.get || !descriptor.set) throw new Error('HTMLImageElement.src seam unavailable');
      (window as any).__imageLifecycleMetrics = { resolveCalls: 0, loadCalls: 0, resolverSignals: [] };
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value: string) {
          (window as any).__imageLifecycleMetrics.loadCalls += 1;
          descriptor.set!.call(this, value);
        }
      });
    });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialText = '# Source\n\n![old](slow-old.png)';
    await page.evaluate((text) => {
      const harness = (window as any).SourceLightweightImageHarness;
      const pending = new Map<string, (value: string) => void>();
      const svg = (label: string, color: string) => (
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="${color}"/><text x="8" y="42">${label}</text></svg>`
        )}`
      );
      harness.setImageSrcResolver((rawSrc: string, signal?: AbortSignal) => {
        (window as any).__imageLifecycleMetrics.resolveCalls += 1;
        (window as any).__imageLifecycleMetrics.resolverSignals.push(signal ?? null);
        if (rawSrc.startsWith('slow-')) {
          return new Promise<string>((resolve) => pending.set(rawSrc, resolve));
        }
        return svg(rawSrc, rawSrc.includes('second') ? '#68a' : '#6a8');
      });
      (window as any).__imageLifecycle = {
        first: harness.createEditor({
          parent: document.getElementById('first'),
          text,
          initialMode: 'source',
          onApplyChanges() {}
        }),
        pending,
        svg
      };
    }, initialText);
    await waitForFrames(page);
    assert.deepEqual(
      await page.evaluate(() => ({
        resolveCalls: (window as any).__imageLifecycleMetrics.resolveCalls,
        loadCalls: (window as any).__imageLifecycleMetrics.loadCalls,
        presentations: document.querySelectorAll('.meo-md-image').length,
        images: document.querySelectorAll('.meo-md-image-img').length
      })),
      { resolveCalls: 0, loadCalls: 0, presentations: 0, images: 0 },
      'production Source bootstrap must do zero image resolve/load/presentation work'
    );

    await page.evaluate(() => (window as any).__imageLifecycle.first.setMode('live'));
    await page.waitForFunction(() => (window as any).__imageLifecycleMetrics.resolveCalls === 1);
    const historyBefore = await page.evaluate(() => {
      const harness = (window as any).SourceLightweightImageHarness;
      return harness.historyDepth((window as any).__imageLifecycle.first);
    });

    const latestText = '# Latest\n\n![latest](latest.png)';
    await page.evaluate((text) => {
      const state = (window as any).__imageLifecycle;
      state.first.setMode('source');
      state.first.setMode('source');
      state.first.setText(text);
      state.first.setMode('live');
    }, latestText);
    await page.waitForFunction(() => document.querySelector('#first .meo-md-image-img') !== null);
    await waitForFrames(page);
    assert.equal(
      await page.evaluate(() => (window as any).__imageLifecycleMetrics.resolverSignals[0]?.aborted ?? false),
      true,
      'Live→Source must propagate cancellation to the production resolver seam'
    );
    const latestSrc = await page.$eval('#first .meo-md-image-img', (image) => image.getAttribute('src') ?? '');
    assert.ok(latestSrc.includes('latest.png'), 'latest Live generation did not render the latest Document image');

    await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      state.pending.get('slow-old.png')?.(state.svg('slow-old.png', '#a66'));
    });
    await waitForFrames(page);
    assert.equal(
      await page.$$eval('#first .meo-md-image-img', (images) => images.some((image) => (
        (image.getAttribute('src') ?? '').includes('slow-old.png')
      ))),
      false,
      'released generation completion must not restore stale image DOM'
    );

    await page.evaluate(() => {
      const harness = (window as any).SourceLightweightImageHarness;
      const state = (window as any).__imageLifecycle;
      state.second = harness.createEditor({
        parent: document.getElementById('second'),
        text: '# Second\n\n![second](second.png)',
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => document.querySelector('#second .meo-md-image-img') !== null);
    await page.evaluate(() => (window as any).__imageLifecycle.first.setMode('source'));
    await waitForFrames(page);
    assert.equal(await page.$eval('#second .meo-md-image-img', (image) => image.isConnected), true);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#first .meo-md-image').length), 0);

    const finalState = await page.evaluate((expectedText) => {
      const harness = (window as any).SourceLightweightImageHarness;
      const state = (window as any).__imageLifecycle;
      return {
        text: state.first.getText(),
        history: harness.historyDepth(state.first),
        metrics: {
          resolveCalls: (window as any).__imageLifecycleMetrics.resolveCalls,
          loadCalls: (window as any).__imageLifecycleMetrics.loadCalls
        },
        secondImages: document.querySelectorAll('#second .meo-md-image-img').length,
        expectedText
      };
    }, latestText);
    assert.equal(finalState.text, finalState.expectedText);
    assert.equal(finalState.history, historyBefore, 'mode switches must not enter Editor History');
    assert.equal(finalState.secondImages, 1, 'one Editor leaving Live must not affect another Editor');
    assert.ok(finalState.metrics.resolveCalls >= 3);
    assert.ok(finalState.metrics.loadCalls >= 2);

    await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      state.first.destroy();
      state.second.destroy();
    });
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Source lightweight Image lifecycle production trace passed');
}

await main();
