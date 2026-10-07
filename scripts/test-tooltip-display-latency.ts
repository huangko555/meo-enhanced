import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: ['scripts/test-tooltip-display-latency-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const script = await build.outputs[0]!.text();
const fixture = '<!doctype html><style>html,body{margin:0;background:white}button{position:fixed;left:100px;top:100px;width:80px;height:30px;color:#888;background:#eee;border:0}</style><button id="target" data-tooltip="Tooltip ready">Target</button>';
const browser = await launchTestBrowser();

async function createFixture(theme = 'light', nested = false, reducedMotion = false) {
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 220 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }]);
  await page.setContent(nested ? '<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe></iframe>' : fixture);
  await page.evaluate(theme => { document.documentElement.dataset.editorAppearance = theme; }, theme);
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const surface = nested ? page.frames()[1]! : page;
  if (nested) await surface.setContent(fixture);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => { (window as any).__binding = (window as any).TooltipLatencyHarness.bindTooltips(document.body); });
  if (nested) await surface.waitForSelector('[data-meo-tooltip-style]');
  // Measure the active reading surface after its initial styles have painted.
  await page.bringToFront();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return { page, surface };
}

try {
  // Screenshots captured by the compositor keep their original paint times.
  // A normal screenshot or RAF observer waits for the blocked renderer to return.
  for (const [theme, nested, reducedMotion] of [
    ['light', false, false], ['dark', false, true], ['dark', true, false]
  ] as const) {
    const { page, surface } = await createFixture(theme, nested, reducedMotion);
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const origin = metrics.find(metric => metric.name === 'NavigationStart')!.value * 1000;
    const stateful = theme === 'light';
    await surface.evaluate(stateful => {
      const target = document.getElementById('target')!;
      if (stateful) target.dataset.tooltipLiveUpdate = 'true';
      target.addEventListener('pointerover', () => {
        // Use the parent clock to align iframe input with the page's trace origin.
        (window as any).__hoverStart = window.top!.performance.now();
        setTimeout(() => {
          const until = performance.now() + 300;
          if (stateful) {
            // Press after the compositor deadline, with JS reveal still queued.
            while (performance.now() < until - 50) { /* Simulate a synchronous render. */ }
            const hint = document.querySelector('.meo-tooltip')!;
            const pending = hint.classList.contains('is-pending');
            const elapsed = window.top!.performance.now() - (window as any).__hoverStart;
            target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            (window as any).__paintedPointerDown = {
              pending, elapsed, after: getComputedStyle(hint).opacity,
              visible: hint.classList.contains('is-visible')
            };
          }
          while (performance.now() < until) { /* Simulate a synchronous diagram render. */ }
          (window as any).__busyDone = true;
        }, 100);
      }, { once: true });
    }, stateful);
    await page.tracing.start({ screenshots: true });
    await surface.hover('#target');
    await surface.waitForFunction(() => (window as any).__busyDone);
    const traceBytes = await page.tracing.stop();
    assert.ok(traceBytes, 'Compositor tracing must return screenshot evidence');
    const hover = await surface.evaluate(() => (window as any).__hoverStart as number);
    const pointer = stateful ? await surface.evaluate(() => (window as any).__paintedPointerDown) : null;
    if (pointer) {
      assert.ok(pointer.elapsed >= 200 && pointer.pending, 'Press must cross the deadline before JS reveal');
      assert.deepEqual({ after: pointer.after, visible: pointer.visible }, { after: '1', visible: true }, 'A due hint remains shown until caller commit');
      // Commit before the decoder tab changes focus and deliberately dismisses the hint.
      await surface.$eval('#target', element => { (element as HTMLElement).dataset.tooltip = 'New painted state'; });
      assert.deepEqual(await surface.$eval('.meo-tooltip', element => ({
        text: element.textContent, opacity: getComputedStyle(element).opacity
      })), { text: 'New painted state', opacity: '1' }, 'The held hint updates at caller commit without another hover');
    }
    const trace = JSON.parse(new TextDecoder().decode(traceBytes));
    const frames: Array<{ millis: number; data: string }> = trace.traceEvents
      .filter((event: any) => event.name === 'Screenshot' && event.args?.snapshot)
      .map((event: any) => ({ millis: event.ts / 1000 - origin - hover, data: event.args.snapshot }));
    const decoder = await browser.newPage();
    const paints = await decoder.evaluate(async frames => {
      const paints: Array<{ millis: number; dark: number }> = [];
      for (const frame of frames) {
        const bytes = Uint8Array.from(atob(frame.data), value => value.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        // The fixture is white; only the real tooltip paints dark pixels above the button.
        const pixels = context.getImageData(40, 50, 200, 45).data;
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i]! < 80 && pixels[i + 1]! < 80 && pixels[i + 2]! < 80) dark++;
        }
        paints.push({ millis: frame.millis, dark });
      }
      return paints;
    }, frames);
    const shown = paints.find(frame => frame.millis >= 180 && frame.millis < 300 && frame.dark > 500);
    if (pointer && shown) assert.ok(shown.millis < pointer.elapsed, 'Actual compositor paint must precede the live press');
    assert.ok(shown, `Tooltip must paint near 200ms during the 100–400ms renderer task: ${JSON.stringify({ theme, nested, reducedMotion, paints })}`);
    assert.ok(paints.filter(frame => frame.millis >= 0 && frame.millis < 180).every(frame => frame.dark < 50), 'Tooltip must not paint before the hover delay');
    console.log(`Tooltip paint: ${theme}, iframe=${nested}, reducedMotion=${reducedMotion}: ${Math.round(shown.millis)}ms`);
    await cdp.detach(); await decoder.close(); await page.close();
  }

  for (const dismissal of ['leave', 'escape', 'click', 'remove', 'dispose', 'tab', 'blur', 'offscreen'] as const) {
    const { page } = await createFixture();
    await page.evaluate(dismissal => {
      const target = document.getElementById('target')!;
      // Run after the adapter's first preparation frame, before driver roundtrips
      // can consume the pending interval. Real editor interactions are checked separately.
      document.body.addEventListener(dismissal === 'tab' ? 'focusin' : 'pointerover', () => requestAnimationFrame(() => {
        const hint = document.querySelector('.meo-tooltip');
        (window as any).__pendingOpacity = hint ? getComputedStyle(hint).opacity : 'missing';
        if (dismissal === 'leave') target.dispatchEvent(new MouseEvent('mouseleave'));
        if (dismissal === 'escape') target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (dismissal === 'click') target.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
        if (dismissal === 'remove') target.remove();
        if (dismissal === 'dispose') (window as any).__binding.dispose();
        if (dismissal === 'tab') target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        if (dismissal === 'blur') window.dispatchEvent(new Event('blur'));
        if (dismissal === 'offscreen') {
          target.style.top = '-100px'; window.dispatchEvent(new Event('scroll'));
        }
      }), { once: true });
    }, dismissal);
    if (dismissal === 'tab') await page.keyboard.press('Tab');
    else await page.hover('#target');
    await page.waitForFunction(() => (window as any).__pendingOpacity !== undefined);
    assert.equal(await page.evaluate(() => (window as any).__pendingOpacity), '0', 'Dismissal must exercise a still-hidden prepared hint');
    // Pass the old deadline to catch either the RAF or CSS/timer resurrecting a hint.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
    assert.equal(await page.$('.meo-tooltip.is-pending,.meo-tooltip.is-visible'), null, `${dismissal} cancels the entire pending presentation`);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.meo-tooltip')].some(element => getComputedStyle(element).opacity !== '0')), false);
    await page.close();
  }

  const { page } = await createFixture();
  await page.$eval('#target', element => {
    const button = element as HTMLButtonElement;
    button.dataset.tooltipLiveUpdate = 'true';
    button.addEventListener('click', () => {
      (window as any).__commit = () => { button.dataset.tooltip = 'New committed state'; };
    });
    document.body.addEventListener('pointerover', () => requestAnimationFrame(() => {
      const hint = document.querySelector('.meo-tooltip')!;
      const before = getComputedStyle(hint).opacity;
      button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      (window as any).__pendingStateDown = { before, after: getComputedStyle(hint).opacity };
    }), { once: true });
  });
  await page.hover('#target');
  await page.waitForFunction(() => (window as any).__pendingStateDown);
  assert.deepEqual(await page.evaluate(() => (window as any).__pendingStateDown), { before: '0', after: '0' }, 'A pending stateful hint waits for caller commit');
  assert.equal(await page.$('.meo-tooltip.is-pending,.meo-tooltip.is-visible'), null);
  await page.evaluate(() => (window as any).__commit());
  assert.deepEqual(await page.$eval('.meo-tooltip', element => ({
    text: element.textContent, opacity: getComputedStyle(element).opacity
  })), { text: 'New committed state', opacity: '1' }, 'Committed state updates show immediately under a stationary pointer');
  await page.mouse.move(0, 0);
  assert.equal(await page.$('.meo-tooltip.is-pending,.meo-tooltip.is-visible'), null);
  await page.close();
  console.log('Tooltip display latency: busy renderer paints, both themes, reduced motion, Preview iframe and pending dismissal/state commit passed.');
} catch (error) {
  await closeTestBrowser(browser, error);
} finally {
  await closeTestBrowser(browser);
}
