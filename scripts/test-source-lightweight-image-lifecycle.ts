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
      '<!doctype html><style>html,body{height:100%;margin:0}.host{height:24%;}</style>',
      '<div id="first" class="host"></div><div id="second" class="host"></div>',
      '<div id="equal" class="host"></div><div id="error" class="host"></div>'
    ].join(''));
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (!descriptor?.get || !descriptor.set) throw new Error('HTMLImageElement.src seam unavailable');
      (window as any).__imageLifecycleMetrics = {
        resolveCalls: 0,
        loadCalls: 0,
        imageErrors: 0,
        resolverSignals: [],
        resolverSignalsBySrc: {},
        resolveCallsBySrc: {}
      };
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value: string) {
          const metrics = (window as any).__imageLifecycleMetrics;
          metrics.loadCalls += 1;
          if (value === 'invalid-image://broken') {
            this.addEventListener('error', () => { metrics.imageErrors += 1; }, { once: true });
          }
          descriptor.set!.call(this, value);
        }
      });
    });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialText = '# Source\n\n![old](slow-old.png)';
    await page.evaluate((text) => {
      const harness = (window as any).SourceLightweightImageHarness;
      const pending = new Map<string, Array<(value: string) => void>>();
      const svg = (label: string, color: string) => (
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="${color}"/><text x="8" y="42">${label}</text></svg>`
        )}`
      );
      harness.setImageSrcResolver((rawSrc: string, signal?: AbortSignal) => {
        const metrics = (window as any).__imageLifecycleMetrics;
        metrics.resolveCalls += 1;
        metrics.resolverSignals.push(signal ?? null);
        const sourceSignals = metrics.resolverSignalsBySrc[rawSrc] ?? [];
        sourceSignals.push(signal ?? null);
        metrics.resolverSignalsBySrc[rawSrc] = sourceSignals;
        metrics.resolveCallsBySrc[rawSrc] = (metrics.resolveCallsBySrc[rawSrc] ?? 0) + 1;
        if (rawSrc.startsWith('slow-')) {
          return new Promise<string>((resolve) => {
            const waiters = pending.get(rawSrc) ?? [];
            waiters.push(resolve);
            pending.set(rawSrc, waiters);
          });
        }
        if (rawSrc === 'retry-error.png' && metrics.resolveCallsBySrc[rawSrc] === 1) {
          return 'invalid-image://broken';
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
    const historyBefore = await page.evaluate(() => (
      (window as any).__imageLifecycle.first.getHistoryDepth()
    ));

    const liveToSourceRollback = await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      const originalDispatch = state.first.view.dispatch;
      let failed = false;
      state.first.view.dispatch = () => { throw new Error('forced Live→Source reconfigure failure'); };
      try {
        state.first.setMode('source');
      } catch {
        failed = true;
      } finally {
        state.first.view.dispatch = originalDispatch;
      }
      return {
        failed,
        aborted: (window as any).__imageLifecycleMetrics.resolverSignals[0]?.aborted ?? false
      };
    });
    assert.deepEqual(liveToSourceRollback, { failed: true, aborted: false },
      'failed Live→Source reconfigure must preserve the active Image generation');
    await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      state.pending.get('slow-old.png')?.[0]?.(state.svg('rollback-live', '#a66'));
    });
    await page.waitForFunction(() => document.querySelector('#first .meo-md-image-img') !== null);

    const latestText = '# Latest\n\n![latest](latest.png)';
    const sourceToLiveRollback = await page.evaluate((text) => {
      const state = (window as any).__imageLifecycle;
      state.first.setMode('source');
      state.first.setMode('source');
      state.first.setText(text);
      const resolveCallsBefore = (window as any).__imageLifecycleMetrics.resolveCalls;
      const originalDispatch = state.first.view.dispatch;
      let failed = false;
      state.first.view.dispatch = () => { throw new Error('forced Source→Live reconfigure failure'); };
      try {
        state.first.setMode('live');
      } catch {
        failed = true;
      } finally {
        state.first.view.dispatch = originalDispatch;
      }
      return {
        failed,
        resolveDelta: (window as any).__imageLifecycleMetrics.resolveCalls - resolveCallsBefore,
        presentations: document.querySelectorAll('#first .meo-md-image').length
      };
    }, latestText);
    assert.deepEqual(sourceToLiveRollback, { failed: true, resolveDelta: 0, presentations: 0 },
      'failed Source→Live reconfigure must release its unused Image lease');
    await page.evaluate(() => (window as any).__imageLifecycle.first.setMode('live'));
    await page.waitForFunction(() => document.querySelector('#first .meo-md-image-img') !== null);
    await waitForFrames(page);
    assert.equal(
      await page.evaluate(() => (window as any).__imageLifecycleMetrics.resolverSignals[0]?.aborted ?? false),
      true,
      'Live→Source must propagate cancellation to the production resolver seam'
    );
    const latestSrc = await page.$eval('#first .meo-md-image-img', (image) => image.getAttribute('src') ?? '');
    assert.ok(latestSrc.includes('latest.png'), 'latest Live generation did not render the latest Document image');

    const equalText = '# Equal\n\n![equal](slow-equal.png)';
    await page.evaluate((text) => {
      const harness = (window as any).SourceLightweightImageHarness;
      const state = (window as any).__imageLifecycle;
      state.equal = harness.createEditor({
        parent: document.getElementById('equal'),
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, equalText);
    await page.waitForFunction(() => (
      (window as any).__imageLifecycle.pending.get('slow-equal.png')?.length === 1
    ));
    await page.evaluate((text) => (window as any).__imageLifecycle.equal.setText(text), equalText);
    await page.waitForFunction(() => (
      (window as any).__imageLifecycle.pending.get('slow-equal.png')?.length === 2
    ));
    assert.equal(
      await page.evaluate(() => (
        (window as any).__imageLifecycleMetrics.resolverSignalsBySrc['slow-equal.png'][0]?.aborted ?? false
      )),
      true,
      'equal-text external must abort the old resource generation'
    );
    await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      state.pending.get('slow-equal.png')?.[0]?.(state.svg('old-generation', '#a66'));
    });
    await waitForFrames(page);
    assert.equal(await page.$('#equal .meo-md-image-img'), null,
      'old equal-text completion must not publish into the current presentation');
    await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      state.pending.get('slow-equal.png')?.[1]?.(state.svg('current-generation', '#6a8'));
    });
    await page.waitForFunction(() => document.querySelector('#equal .meo-md-image-img') !== null);
    assert.ok((await page.$eval('#equal .meo-md-image-img', (image) => image.getAttribute('src') ?? ''))
      .includes('current-generation'));

    await page.evaluate((text) => (window as any).__imageLifecycle.equal.setText(text), equalText);
    await page.waitForFunction(() => (
      (window as any).__imageLifecycle.pending.get('slow-equal.png')?.length === 3
    ));
    await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      state.pending.get('slow-equal.png')?.[2]?.(state.svg('ready-represented', '#68a'));
    });
    await page.waitForFunction(() => (
      document.querySelector('#equal .meo-md-image-img')?.getAttribute('src')?.includes('ready-represented')
    ));

    const errorText = '# Error\n\n![retry](retry-error.png)';
    await page.evaluate((text) => {
      const harness = (window as any).SourceLightweightImageHarness;
      const state = (window as any).__imageLifecycle;
      state.error = harness.createEditor({
        parent: document.getElementById('error'),
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, errorText);
    await page.waitForFunction(() => (
      (window as any).__imageLifecycleMetrics.imageErrors === 1 &&
      document.querySelector('#error .meo-md-image-fallback') !== null
    ));
    await page.evaluate((text) => (window as any).__imageLifecycle.error.setText(text), errorText);
    await page.waitForFunction(() => document.querySelector('#error .meo-md-image-img') !== null);
    assert.equal(
      await page.evaluate(() => (window as any).__imageLifecycleMetrics.resolveCallsBySrc['retry-error.png']),
      2,
      'equal-text external must retry a failed current presentation in the new generation'
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
      const state = (window as any).__imageLifecycle;
      return {
        text: state.first.getText(),
        history: state.first.getHistoryDepth(),
        metrics: {
          resolveCalls: (window as any).__imageLifecycleMetrics.resolveCalls,
          loadCalls: (window as any).__imageLifecycleMetrics.loadCalls
        },
        secondImages: document.querySelectorAll('#second .meo-md-image-img').length,
        expectedText
      };
    }, latestText);
    assert.equal(finalState.text, finalState.expectedText);
    assert.deepEqual(finalState.history, historyBefore, 'mode switches must not enter Editor History');
    assert.equal(finalState.secondImages, 1, 'one Editor leaving Live must not affect another Editor');
    assert.ok(finalState.metrics.resolveCalls >= 3);
    assert.ok(finalState.metrics.loadCalls >= 2);

    await page.evaluate(() => {
      const state = (window as any).__imageLifecycle;
      state.first.destroy();
      state.second.destroy();
      state.equal.destroy();
      state.error.destroy();
    });
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Source lightweight Image lifecycle production trace passed');
}

await main();
