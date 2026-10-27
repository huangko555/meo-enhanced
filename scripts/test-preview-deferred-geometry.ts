import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw Error(build.logs.map(String).join('\n'));
process.env.MEO_TEST_NATIVE_SMOOTH_SCROLLING = '1';
const browser = await launchTestBrowser();
try {
  for (const scenario of ['ready', 'wheel-active', 'smooth-tail', 'margin', 'gap', 'multiple', 'authored-size', 'error', 'hidden', 'replaced', 'font-increase', 'font-decrease', 'font-user-scroll', 'font-superseded', 'font-hidden', 'font-replaced']) {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    const fontChange = scenario.startsWith('font-');
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.setViewport({ width: 800, height: 600 });
    let releaseImage!: () => Promise<void>;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url() !== 'https://preview-image.test/tall.svg') {
        void request.continue();
        return;
      }
      releaseImage = () => request.respond({ status: scenario === 'error' ? 404 : 200,
        contentType: 'image/svg+xml', headers: {'Cache-Control': 'no-store'},
        body: scenario === 'error' ? '' : '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="blue"/></svg>' });
    });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    if (fontChange) await page.evaluate(() => document.body.classList.add('vscode-light'));
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.exposeFunction('__renderPreview', async (message: any) => {
      if (message.type === 'resolveImageSrc') return {
        type: 'resolvedImageSrc', requestId: message.requestId,
        result: { ok: true, value: { resolvedUrl: message.url } }
      };
      if (message.type !== 'requestPreviewRender') return null;
      return { type: 'previewRenderResult', requestId: message.requestId,
        result: { ok: true, value: exportRuntime.renderPreviewDocument({
          markdownText: message.text, sourceDocumentPath: 'C:/tmp/preview-geometry.md',
          uiLanguage: message.uiLanguage, styleEnvironment: message.environment
        }) } };
    });
    await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ content: await build.outputs[0]!.text() });
    const text = [
      '# Reading geometry', scenario === 'gap'
        ? '<img src="https://preview-image.test/tall.svg" width="16" height="16" alt="Pending image">'
        : scenario === 'authored-size'
        ? '<img src="https://preview-image.test/tall.svg" width="320" alt="Pending image" title="Authored image">'
        : '![Pending image](https://preview-image.test/tall.svg)',
      ...(fontChange ? ['```ts\n' + Array.from({length: 24}, (_, index) => `const value${index} = ${index};`).join('\n') + '\n```'] : []),
      ...(scenario === 'multiple' ? ['![Second image](https://preview-image.test/tall.svg)'] : []),
      ...Array.from({length: 40}, (_, index) => `Reading paragraph ${index}: stable content below a pending image.`)
    ].join('\n\n');
    await page.evaluate(({text, fontChange}) => window.dispatchEvent(new MessageEvent('message', {data: {
      type: 'init', documentId: 'file:///preview-geometry.md', text, version: 1,
      savedRevision: {version: 1, text}, diagnostics: [], mode: 'source', uiLanguage: 'en',
      sourceLineNumbers: 'on', previewAppearance: fontChange ? 'light' : 'dark', previewFontFamily: '', previewSourceColoring: fontChange,
      editorAppearance: fontChange ? 'light' : 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: {wholeWord: false, caseSensitive: false},
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
    }})), {text, fontChange});
    await page.waitForSelector('.cm-content');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')!.dataset.mode === 'source'
      && document.querySelector<HTMLElement>('.preview-host')!.hidden);
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLElement>('button[data-mode=preview]');
      return button?.offsetParent !== null && getComputedStyle(button).visibility === 'visible';
    });
    if (fontChange) {
      await page.click('.more-tools-wrapper > button');
      await page.click('[data-editor-font-size-mode="custom"]');
      await page.evaluate(() => {
        const increase = document.querySelector<HTMLButtonElement>('.editor-font-size-stepper-button:last-child')!;
        increase.click();increase.click();
      });
    }
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')!.dataset.mode === 'preview'
      && !document.querySelector<HTMLElement>('.preview-host')!.hidden
      && !document.querySelector('.editor-host')!.hasAttribute('data-preview-cover'));
    const frameBox = await (await page.$('.preview-frame'))!.boundingBox();
    assert.ok(frameBox);
    if (scenario === 'gap') await page.evaluate(async () => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const anchor = Array.from(doc.querySelectorAll('p')).find(p => p.textContent!.startsWith('Reading paragraph 4:'))!;
      (anchor as HTMLElement).style.marginBottom = '300px';
      // Establish whitespace geometry before sampling the reading position.
      // Otherwise its pending resize is mixed into the neutral image commit.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await page.mouse.wheel({deltaY: 1});
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = await page.evaluate(({ margin, paragraph }) => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const anchor = paragraph === -1 ? doc.querySelector('h1')! : Array.from(doc.querySelectorAll('p')).find(p => p.textContent!.startsWith(`Reading paragraph ${paragraph}:`))!;
      anchor.setAttribute('data-reading-anchor', 'true');
      // Put the reading band inside whitespace while the current top stays on
      // a real paragraph. The fixed-size image commit must not quantize it.
      anchor.scrollIntoView({block: 'start'});
      if (margin) doc.scrollingElement!.scrollTop -= 10;
      if (paragraph === -1) doc.scrollingElement!.scrollTop = 0;
      return anchor.getBoundingClientRect().top;
    }, { margin: scenario === 'margin', paragraph: fontChange ? -1 : 4 });
    let imageBaseline = before;
    const beforeHeight = await page.$eval('.preview-frame', element =>
      (element as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollHeight);
    assert.ok(releaseImage, 'The visible image must start loading before moving the reading position');
    if (fontChange) {
      const oldSize = await page.$eval('.preview-frame', element => {
        const doc = (element as HTMLIFrameElement).contentDocument!;
        return doc.defaultView!.getComputedStyle(doc.querySelector('pre code')!).fontSize;
      });
      await page.evaluate(increase => document.querySelector<HTMLButtonElement>(increase
        ? '.editor-font-size-stepper-button:last-child' : '.editor-font-size-stepper-button:first-child')!.click(), scenario === 'font-increase');
      await page.waitForFunction(previous => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        return doc.defaultView!.getComputedStyle(doc.querySelector('pre code')!).fontSize !== previous;
      }, {}, oldSize);
      const afterFont = await page.$eval('.preview-frame', element => (element as HTMLIFrameElement)
        .contentDocument!.querySelector('[data-reading-anchor]')!.getBoundingClientRect().top);
      assert.ok(Math.abs(afterFont - before) <= 12, `Font update must retain the anchor before releasing the image: ${before} -> ${afterFont}`);
      imageBaseline = afterFont;
    }

    if (scenario === 'font-superseded') {
      const previous = await page.$eval('.preview-frame', element => {
        const doc = (element as HTMLIFrameElement).contentDocument!;
        return doc.defaultView!.getComputedStyle(doc.querySelector('pre code')!).fontSize;
      });
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('.editor-font-size-stepper-button:last-child')!.click());
      await page.waitForFunction(previous => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        return doc.defaultView!.getComputedStyle(doc.querySelector('pre code')!).fontSize !== previous;
      }, {}, previous);
      imageBaseline = await page.evaluate(async () => {
        // Let the obsolete appearance callback retire without releasing its successor.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector('[data-reading-anchor]')!.getBoundingClientRect().top;
      });
    }
    if (scenario === 'font-user-scroll') {
      await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
      await page.mouse.wheel({deltaY: 180});
      imageBaseline = await page.evaluate(async () => {
        for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        if (doc.scrollingElement!.scrollTop < 50) throw Error('Trusted wheel must establish a newer reading position');
        doc.querySelector('[data-reading-anchor]')!.removeAttribute('data-reading-anchor');
        const anchor = doc.querySelector('pre')!;
        anchor.setAttribute('data-reading-anchor', 'true');
        return anchor.getBoundingClientRect().top;
      });
    }
    let sourceTop = 0;
    if (['hidden', 'replaced', 'font-hidden', 'font-replaced'].includes(scenario)) {
      await page.click('button[data-mode="source"]');
      // The click starts an asynchronous mode/anchor transition. Establish the
      // hidden-consumer baseline only after Source has finished moving, while
      // the image response is still held; otherwise its own restore is blamed
      // on the later image completion.
      await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')!.dataset.mode === 'source'
        && document.querySelector<HTMLElement>('.preview-host')!.hidden);
      sourceTop = await page.evaluate(async () => {
        const scroller = document.querySelector('.cm-scroller')!;
        let previous = scroller.scrollTop;
        let stable = 0;
        for (let frame = 0; frame < 60; frame += 1) {
          await new Promise(requestAnimationFrame);
          const current = scroller.scrollTop;
          stable = Math.abs(current - previous) < 0.1 ? stable + 1 : 0;
          previous = current;
          if (stable === 4) return current;
        }
        throw Error('Source did not settle before releasing the pending image');
      });
    }
    if (scenario === 'replaced' || scenario === 'font-replaced') {
      await page.click('.cm-content');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.type('Replacement document without an image');
      await page.click('button[data-mode="preview"]');
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
        .contentDocument!.body.textContent!.includes('Replacement document without an image'));
      // The obsolete frame cancels its network request; Chromium may already have
      // discarded the interception by the time this controlled response arrives.
      await releaseImage().catch(() => undefined);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await page.$eval('.preview-frame', element => (element as HTMLIFrameElement).contentDocument!.images.length), 0);
      assert.deepEqual(pageErrors, []);
      await page.close();
      continue;
    }
    if (scenario === 'wheel-active') {
      await page.mouse.wheel({ deltaY: 1 });
      imageBaseline = await page.evaluate(async () => {
        for (let index = 0; index < 2; index++) await new Promise(requestAnimationFrame);
        return document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector('[data-reading-anchor]')!.getBoundingClientRect().top;
      });
    }
    if (scenario === 'smooth-tail') {
      await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, scroll = doc.scrollingElement!;
        const anchor = doc.querySelector('[data-reading-anchor]')!;
        const state = (window as any).__imageScroll = { active: true, compensation: 0, samples: [] as number[], tops: [] as number[] };
        const descriptor = Object.getOwnPropertyDescriptor(doc.defaultView!.Element.prototype, 'scrollTop')!;
        Object.defineProperty(scroll, 'scrollTop', { configurable: true, get() { return descriptor.get!.call(this); }, set(top) {
          const before = descriptor.get!.call(this); descriptor.set!.call(this, top);
          state.compensation += descriptor.get!.call(this) - before;
        } });
        const sample = () => {
          if (!state.active) return;
          state.samples.push(anchor.getBoundingClientRect().top + scroll.scrollTop - state.compensation);
          state.tops.push(anchor.getBoundingClientRect().top); requestAnimationFrame(sample);
        }; sample();
        // Test-only native animation, started by an unconsumed trusted wheel.
        doc.addEventListener('wheel', event => {
          if (event.defaultPrevented || !event.isTrusted) throw Error('Preview consumed the image scroll gesture');
          event.preventDefault(); scroll.scrollBy({ top: event.deltaY, behavior: 'smooth' });
        }, { passive: false, once: true });
      });
      await page.mouse.wheel({ deltaY: 240 });
      await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
    }
    await releaseImage();
    await page.waitForFunction(({failed, count}) => {
      const images = Array.from(document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.images);
      return images.length === count && images.every(img => img.complete && img.naturalHeight === (failed ? 0 : 640)
        && img.src === 'https://preview-image.test/tall.svg');
    }, {}, {failed: scenario === 'error', count: scenario === 'multiple' ? 2 : 1});
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (scenario === 'smooth-tail') await page.evaluate(async () => { for (let i = 0; i < 52; i++) await new Promise(requestAnimationFrame); });
    const after = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
      .contentDocument!.querySelector('[data-reading-anchor]')!.getBoundingClientRect().top);
    if (scenario === 'gap') {
      const afterHeight = await page.$eval('.preview-frame', element =>
        (element as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollHeight);
      assert.equal(afterHeight, beforeHeight, 'The fixed-size image must exercise a geometry-neutral commit');
    }
    if (scenario === 'hidden' || scenario === 'font-hidden') {
      assert.equal(await page.$eval('#app', element => (element as HTMLElement).dataset.mode), 'source');
      const sourceAfter = await page.$eval('.cm-scroller', element => element.scrollTop);
      assert.ok(Math.abs(sourceAfter - sourceTop) < 2,
        `A hidden Preview image must not project an anchor into Source: ${sourceTop} -> ${sourceAfter}`);
    } else if (scenario === 'smooth-tail') {
      const state = await page.evaluate(() => { const state = (window as any).__imageScroll; state.active = false;
        return state as { samples: number[]; tops: number[] }; });
      assert.ok(Math.max(...state.samples) - Math.min(...state.samples) <= 2, 'Late image geometry must retain the moving reading witness');
      assert.ok(new Set(state.tops).size >= 5, `The image case must observe native intermediate frames: ${JSON.stringify(state)}`);
      assert.ok(state.tops.every((top, i) => i === 0 || top <= state.tops[i - 1]! + 2), 'Late image must not pull reading backward');
      const tail = state.tops.slice(-8);
      assert.ok(Math.max(...tail) - Math.min(...tail) <= 1, 'The native tail and late image must settle');
    } else {
      // Chromium can land exactly two device-independent pixels apart after
      // resolving fractional line geometry; anything larger is visible drift.
      assert.ok(Math.abs(after - imageBaseline) <= 2,
        `${scenario}: A late image moved the user's current reading anchor: ${imageBaseline} -> ${after}`);
    }
    if (scenario === 'authored-size') {
      const attributes = await page.$eval('.preview-frame', element => {
        const img = (element as HTMLIFrameElement).contentDocument!.images[0]!;
        return {width: img.getAttribute('width'), loading: img.getAttribute('loading'), title: img.getAttribute('title'),
          hint: img.dataset.tooltip, hintKind: img.dataset.tooltipKind, alt: img.alt};
      });
      assert.deepEqual(attributes, {width: '320', loading: null, title: null,
        hint: 'Authored image', hintKind: 'description', alt: 'Pending image'});
    }
    assert.deepEqual(pageErrors, []);
    await page.close();
  }
  console.log('Preview deferred image geometry checks passed');
} finally {
  await browser.close();
}
