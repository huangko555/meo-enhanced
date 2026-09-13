import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  for (const scenario of ['ready', 'margin', 'multiple', 'authored-size', 'error', 'hidden', 'replaced']) {
    const page = await browser.newPage();
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
      '# Reading geometry', scenario === 'authored-size'
        ? '<img src="https://preview-image.test/tall.svg" width="320" alt="Pending image" title="Authored image">'
        : '![Pending image](https://preview-image.test/tall.svg)',
      ...(scenario === 'multiple' ? ['![Second image](https://preview-image.test/tall.svg)'] : []),
      ...Array.from({length: 40}, (_, index) => `Reading paragraph ${index}: stable content below a pending image.`)
    ].join('\n\n');
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', {data: {
      type: 'init', documentId: 'file:///preview-geometry.md', text, version: 1,
      savedRevision: {version: 1, text}, diagnostics: [], mode: 'source', uiLanguage: 'en',
      sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: false,
      editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: {wholeWord: false, caseSensitive: false},
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
    }})), text);
    await page.waitForSelector('.cm-content');
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => !document.querySelector('.editor-host')!.hasAttribute('data-preview-cover'));
    const frameBox = await (await page.$('.preview-frame'))!.boundingBox();
    assert.ok(frameBox);
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await page.mouse.wheel({deltaY: 1});
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = await page.evaluate(margin => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const anchor = Array.from(doc.querySelectorAll('p')).find(p => p.textContent!.startsWith('Reading paragraph 4:'))!;
      anchor.setAttribute('data-reading-anchor', 'true');
      anchor.scrollIntoView({block: 'start'});
      if (margin) doc.scrollingElement!.scrollTop -= 10;
      return anchor.getBoundingClientRect().top;
    }, scenario === 'margin');
    assert.ok(releaseImage, 'The visible image must start loading before moving the reading position');
    let sourceTop = 0;
    if (scenario === 'hidden' || scenario === 'replaced') {
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
    if (scenario === 'replaced') {
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
    await releaseImage();
    await page.waitForFunction(({failed, count}) => {
      const images = Array.from(document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.images);
      return images.length === count && images.every(img => img.complete && img.naturalHeight === (failed ? 0 : 640)
        && img.src === 'https://preview-image.test/tall.svg');
    }, {}, {failed: scenario === 'error', count: scenario === 'multiple' ? 2 : 1});
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
      .contentDocument!.querySelector('[data-reading-anchor]')!.getBoundingClientRect().top);
    if (scenario === 'hidden') {
      assert.equal(await page.$eval('#app', element => (element as HTMLElement).dataset.mode), 'source');
      const sourceAfter = await page.$eval('.cm-scroller', element => element.scrollTop);
      assert.ok(Math.abs(sourceAfter - sourceTop) < 2,
        `A hidden Preview image must not project an anchor into Source: ${sourceTop} -> ${sourceAfter}`);
    } else {
      // Chromium can land exactly two device-independent pixels apart after
      // resolving fractional line geometry; anything larger is visible drift.
      assert.ok(Math.abs(after - before) <= 2,
        `${scenario}: A late image moved the user's current reading anchor: ${before} -> ${after}`);
    }
    if (scenario === 'authored-size') {
      const attributes = await page.$eval('.preview-frame', element => {
        const img = (element as HTMLIFrameElement).contentDocument!.images[0]!;
        return {width: img.getAttribute('width'), loading: img.getAttribute('loading'), title: img.title, alt: img.alt};
      });
      assert.deepEqual(attributes, {width: '320', loading: null, title: 'Authored image', alt: 'Pending image'});
    }
    assert.deepEqual(pageErrors, []);
    await page.close();
  }
  console.log('Preview deferred image geometry checks passed');
} finally {
  await browser.close();
}
