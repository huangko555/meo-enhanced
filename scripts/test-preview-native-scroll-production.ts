import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

process.env.MEO_TEST_NATIVE_SMOOTH_SCROLLING = '1';
const { browser, server, open, frames } = await import('./input-presentation-test-helpers');

const prose = (count: number) => Array.from({ length: count }, (_, index) =>
  `Paragraph ${index}: ${'A stable reading witness. '.repeat(8)}\n`).join('\n');
const ordinary = prose(120), large = prose(4000);
const code = '```js\n' + Array.from({ length: 18000 }, (_, index) => `const row${index} = "value ${index}";`).join('\n') + '\n```';
const list = Array.from({ length: 6000 }, (_, index) => `${index + 1}. Item ${index} with a stable reading witness.`).join('\n');
const cases = [
  { name: 'source-control', text: ordinary, mode: 'source' },
  { name: 'live-control', text: ordinary, mode: 'live' },
  { name: 'ordinary', text: ordinary, mode: 'preview' },
  { name: 'large-prose', text: large, mode: 'preview' },
  { name: 'long-code', text: code, mode: 'preview' },
  { name: 'long-list', text: list, mode: 'preview' },
  { name: 'split-independent', text: list, mode: 'source', split: false },
  { name: 'split-linked', text: list, mode: 'source', split: true }
] as const;

async function record(page: Page, animated: boolean) {
  return page.evaluate(animated => {
    const scope = window as any, scroll = scope.__nativeScrollElement as Element;
    const doc = scroll.ownerDocument, bounds = scroll === doc.scrollingElement
      ? { top: 0, bottom: doc.defaultView!.innerHeight } : scroll.getBoundingClientRect();
    const witness = [...doc.querySelectorAll<HTMLElement>('main p, main li, .meo-export-code-line, .editor-host .cm-line')].find(element => {
      const r = element.getBoundingClientRect(); return r.height > 0 && r.top > bounds.top + 200 && r.bottom < bounds.bottom - 100;
    });
    if (!witness) throw Error('A concrete reading witness is required');
    scope.__nativeAnimated = animated;
    scope.__nativeTrace = { wheels: [], writes: [], samples: [], witness, initial: scroll.scrollTop,
      witnessTop: witness.getBoundingClientRect().top };
    return scroll.scrollTop;
  }, animated);
}

async function result(page: Page) {
  return page.evaluate(() => {
    const scope = window as any, trace = scope.__nativeTrace, scroll = scope.__nativeScrollElement as Element;
    return { wheels: trace.wheels as Array<{ trusted: boolean; prevented: boolean; delta: number; top: number }>,
      writes: trace.writes as Array<{ before: number; after: number }>, initial: trace.initial as number, top: scroll.scrollTop,
      samples: trace.samples as Array<{ top: number; witness: number | null; source: number }>,
      visualDelta: trace.witness.isConnected ? trace.witness.getBoundingClientRect().top - trace.witnessTop as number : null };
  });
}

async function settleNativeMotion(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const scope = window as any, scroll = scope.__nativeScrollElement as Element;
    const clock = scroll.ownerDocument.defaultView!;
    let previous = scroll.scrollTop, stillSince: number | null = null, frame = 0;
    const timeout = window.setTimeout(() => {
      clock.cancelAnimationFrame(frame);
      reject(new Error('Native scrolling did not settle within three seconds'));
    }, 3000);
    const sample = (now: number) => {
      const top = scroll.scrollTop;
      if (Math.abs(top - previous) < 0.01) stillSince ??= now;
      else stillSince = null;
      previous = top;
      if (scope.__nativeTrace.wheels.length && stillSince !== null && now - stillSince >= 100) {
        window.clearTimeout(timeout); resolve();
      } else frame = clock.requestAnimationFrame(sample);
    };
    frame = clock.requestAnimationFrame(sample);
  }));
}

function assertMotion(value: Awaited<ReturnType<typeof result>>, delta: number, animated: boolean, label: string, geometryChanges = false) {
  assert.ok(value.wheels.length && value.wheels.every(wheel => wheel.trusted && !wheel.prevented), `${label}: native wheel was intercepted`);
  const compensation = geometryChanges ? value.writes.reduce((sum, write) => sum + write.after - write.before, 0) : 0;
  assert.ok(Math.abs(value.top - value.initial - compensation - delta) <= 2, `${label}: lost motion ${JSON.stringify(value)}`);
  assert.notEqual(value.visualDelta, null, `${label}: lost reading witness`);
  assert.ok(Math.abs(value.visualDelta! + delta) <= 2, `${label}: visible content disagrees with native input`);
  if (animated) assert.ok(new Set(value.samples.map(sample => sample.top)).size >= 5, `${label}: native animation was collapsed`);
  for (let index = 1; index < value.samples.length; index++) {
    const previous = value.samples[index - 1]!, current = value.samples[index]!;
    assert.ok((current.top - previous.top) * Math.sign(delta) >= -1, `${label}: unexpected pullback`);
    if (current.witness !== null && previous.witness !== null) {
      const geometry = current.witness - previous.witness + current.top - previous.top;
      assert.ok(Math.abs(geometry) <= 2 || geometryChanges && value.writes.some(write => Math.abs(write.after - write.before - geometry) <= 1),
        `${label}: intermediate reading drift`);
    }
  }
  const tail = value.samples.slice(-8).map(sample => sample.top);
  assert.ok(tail.length === 8 && Math.max(...tail) - Math.min(...tail) <= 1, `${label}: motion did not stop`);
}

let primary: unknown;
try {
  for (const testCase of cases) {
    if (process.env.MEO_SCROLL_CASE && testCase.name !== process.env.MEO_SCROLL_CASE) continue;
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    const host = await open(page, testCase.text, false, testCase.mode,
      'split' in testCase ? { beforePreviewRender: () => new Promise(resolve => setTimeout(resolve, 350)) } : {});
    try {
      const preview = testCase.mode === 'preview' || 'split' in testCase;
      if ('split' in testCase) {
        await page.click('.source-preview-button');
        await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-loading')?.hidden);
        assert.equal(await page.$eval('.preview-frame', element => (element as HTMLIFrameElement).contentDocument!.documentElement.inert), true);
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')?.hidden
          && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main'));
        if (await page.$eval('.source-preview-scroll-sync-button', element => element.getAttribute('aria-pressed') === 'true') !== testCase.split) {
          await page.click('.source-preview-scroll-sync-button');
        }
      }
      await frames(page, 12);
      const point = await page.evaluate(preview => {
        const scope = window as any, frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
        const doc = preview ? frame!.contentDocument! : document;
        const scroll = preview ? doc.scrollingElement! : doc.querySelector('.editor-host > .cm-editor .cm-scroller')!;
        scope.__nativeScrollElement = scroll;
        const descriptor = Object.getOwnPropertyDescriptor(doc.defaultView!.Element.prototype, 'scrollTop')!;
        Object.defineProperty(scroll, 'scrollTop', { configurable: true,
          get() { return descriptor.get!.call(this); }, set(value) {
            const before = descriptor.get!.call(this); descriptor.set!.call(this, value);
            scope.__nativeTrace?.writes.push({ before, after: descriptor.get!.call(this) });
          } });
        doc.addEventListener('wheel', event => {
          scope.__nativeTrace?.wheels.push({ trusted: event.isTrusted, prevented: event.defaultPrevented, delta: event.deltaY, top: scroll.scrollTop });
          // CDP wheel is instantaneous in headless Chromium. Change only this
          // test's platform default, after recording whether production consumed
          // the trusted event; the browser still owns every animation frame.
          if (!event.defaultPrevented && scope.__nativeAnimated) {
            event.preventDefault(); scroll.scrollBy({ top: event.deltaY, behavior: 'smooth' });
          }
        }, { passive: false });
        const sample = () => {
          const trace = scope.__nativeTrace;
          if (trace) trace.samples.push({ top: scroll.scrollTop,
            witness: trace.witness.isConnected ? trace.witness.getBoundingClientRect().top : null,
            source: document.querySelector('.editor-host .cm-scroller')?.scrollTop ?? 0 });
          requestAnimationFrame(sample);
        }; requestAnimationFrame(sample);
        const rect = preview ? frame!.getBoundingClientRect() : scroll.getBoundingClientRect();
        return { x: rect.left + 200, y: rect.top + 350, windowed: doc.documentElement.dataset.meoPreviewWindowed === 'true' };
      }, preview);
      if (preview) assert.equal(point.windowed, assessLargeDocument(testCase.text).windowedPreview, `${testCase.name}: expected scale path`);
      await page.mouse.move(point.x, point.y);
      for (const [animated, delta] of [[false, 360], [true, 720], [true, -360]] as const) {
        await record(page, animated); await page.mouse.wheel({ deltaY: delta }); await frames(page, 52);
        await settleNativeMotion(page);
        const value = await result(page); assertMotion(value, delta, animated, `${testCase.name}/${animated}/${delta}`);
        if ('split' in testCase) {
          const sourceDelta = value.samples.at(-1)!.source - value.samples[0]!.source;
          assert.ok(testCase.split ? sourceDelta * Math.sign(delta) > 0 : Math.abs(sourceDelta) <= 1, `${testCase.name}: split ownership`);
        }
      }
      // Reverse before the previous native animation ends. It must follow the
      // new direction and never resume the abandoned destination after idle.
      await record(page, true); await page.mouse.wheel({ deltaY: 600 }); await frames(page, 4);
      await record(page, true); await page.mouse.wheel({ deltaY: -240 }); await frames(page, 52);
      await settleNativeMotion(page);
      const reverse = await result(page);
      // The compositor can progress between issuing CDP input and actual wheel
      // delivery. Compare against receipt, not the earlier automation command.
      const received = reverse.wheels[0]!;
      assert.ok(received.trusted && !received.prevented && Math.abs(reverse.top - received.top + 240) <= 2,
        `${testCase.name}: reversal was delayed ${JSON.stringify(reverse)}`);
      const reverseTail = reverse.samples.slice(-8).map(sample => sample.top);
      assert.ok(Math.max(...reverseTail) - Math.min(...reverseTail) <= 1, `${testCase.name}: stale animation returned`);

      // Fine pixel packets include a decaying tail and direction changes. These
      // are trusted CDP inputs, not a claim to emulate physical trackpad feel.
      const packets = [8, 12, 18, 18, 12, 8, 4, 2];
      for (const sign of [1, -1]) {
        await record(page, false);
        for (const delta of packets) { await page.mouse.wheel({ deltaY: delta * sign }); await frames(page, 1); }
        await frames(page, 16);
        await settleNativeMotion(page);
        assertMotion(await result(page), packets.reduce((sum, delta) => sum + delta, 0) * sign, false, `${testCase.name}/pixel/${sign}`);
      }
      if (testCase.name === 'long-list') {
        // Crossing a cold band can require a real layout correction. That
        // correction may end Chromium's animation; it must neither pull back
        // nor replay the abandoned target after the next gesture.
        await record(page, true); await page.mouse.wheel({ deltaY: 3600 }); await frames(page, 90);
        await settleNativeMotion(page);
        const crossing = await result(page);
        assert.ok(crossing.top > crossing.initial + 500 && crossing.top <= crossing.initial + 3604);
        assert.ok(crossing.top >= crossing.initial + 3598 || crossing.writes.some(write => Math.abs(write.after - write.before) > 1),
          'An early end needs evidence of a necessary geometry correction');
        assert.ok(crossing.samples.every((sample, index, samples) => index === 0 || sample.top >= samples[index - 1]!.top - 1));
        const tail = crossing.samples.slice(-8).map(sample => sample.top);
        assert.ok(Math.max(...tail) - Math.min(...tail) <= 1, 'Band correction must settle');
        assert.ok(await page.$eval('.preview-frame', frame => (frame as HTMLIFrameElement).contentDocument!
          .querySelectorAll('[data-meo-container-part] > li').length < 256), 'Native motion must keep bounded DOM');
        await record(page, false); await page.mouse.wheel({ deltaY: -120 }); await frames(page, 20);
        await settleNativeMotion(page);
        assertMotion(await result(page), -120, false, 'list/cold-boundary/reverse', true);
        console.log(`long-list cold boundary: ${crossing.top - crossing.initial}px native progress, ${crossing.writes.length} geometry writes`);
      }
      // Existing programmatic navigation remains immediate, without CSS smooth.
      assert.equal(await page.evaluate(() => {
        const scroll = (window as any).__nativeScrollElement as Element;
        const top = scroll.scrollTop + 80;
        scroll.scrollTo({ top, behavior: 'auto' });
        return scroll.scrollTop === top && scroll.ownerDocument.defaultView!.getComputedStyle(scroll).scrollBehavior === 'auto';
      }), true);
      assert.deepEqual(host.errors, []);
      console.log(`${testCase.name}: native wheel, multi-frame progress, reversal, fine packets and idle stability passed`);
    } finally { host.dispose(); await page.close(); }
  }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
