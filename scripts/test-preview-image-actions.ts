import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-code-update-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
let release = () => {}, hold = false, fail = false, recovered = false, tall = false;
let lateImage = Promise.resolve(), releaseLateImage = () => {};
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/late.svg') await lateImage;
  if (url.searchParams.has('meoReload') && hold) await new Promise<void>(resolve => { release = resolve; });
  if ((url.searchParams.has('meoReload') && fail) || (url.pathname === '/broken.svg' && !recovered)) return new Response('', { status: 404 });
  return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${tall ? 420 : 240}"><rect width="640" height="100%" fill="#4579ad"/><text x="32" y="80" fill="white" font-size="36">Image detail</text></svg>`,
    { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
} });
const browser = await launchTestBrowser();
const output = '.local/probes/preview-image-actions';
fs.mkdirSync(output, { recursive: true });
let primaryError: unknown;
try {
  for (const [large, layout, language, appearance] of [
    [false, 'full', 'en', 'light'], [false, 'side', 'zh-CN', 'dark'],
    [true, 'full', 'zh-CN', 'dark'], [true, 'side', 'en', 'light']
  ] as const) {
    hold = fail = recovered = tall = false;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: layout === 'side' ? 620 : 1000, height: 800 });
    await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}</style><body></body>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: '.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}' });
    await page.addScriptTag({ content: await build.outputs[0]!.text() });
    const messages: any[] = [], documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
    await page.exposeFunction('__imageHost', async (message: any) => {
      messages.push(message);
      if (message.type === 'resolveImageSrc') return { type: 'resolvedImageSrc', requestId: message.requestId,
        result: { ok: true, value: { resolvedUrl: new URL(message.url, server.url).href } } };
      if (message.type === 'requestPreviewDocument') return { type: 'previewDocumentResult', requestId: message.requestId,
        documentId: message.documentId, result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
      if (message.type !== 'requestPreviewRender') return null;
      const options = { markdownText: message.text, sourceDocumentPath: 'C:/fixture/images.md', uiLanguage: message.uiLanguage,
        layout: message.layout, styleEnvironment: message.environment };
      const parsed = message.window ? createPreviewDocument(message.requestId, options) : undefined;
      if (parsed) documents.set(message.requestId, parsed);
      return { type: 'previewRenderResult', requestId: message.requestId,
        result: { ok: true, value: parsed ? parsed.open(message.window.anchorLine) : exportRuntime.renderPreviewDocument(options) } };
    });
    await page.evaluate(() => {
      const scope = window as any;
      const send = (message: any) => scope.__imageHost(message).then((response: any) => {
        if (!response) return;
        if (response.type === 'resolvedImageSrc') scope.__settleImageSrcRequest(response);
        else if (response.type === 'previewDocumentResult') scope.__previewController.acceptDocumentResponse(response);
        else scope.__previewController.acceptRenderResponse(response);
      });
      scope.__previewHostMessage = send; scope.__initializeImageHandling({ postMessage: send });
    });
    const text = ['# Image actions', 'Before the image.', '![local](local.svg)', 'Reading anchor below image. ' + 'Visible reading content remains in place while the image changes. '.repeat(24),
      '[![linked](linked.svg)](https://example.com/image-link)',
      `<img src="${new URL('/remote.svg', server.url)}" width="160" alt="html">`,
      `<picture><source media="(min-width: 1px)" srcset="${new URL('/picture.svg', server.url)} 1x, ${new URL('/picture-2x.svg', server.url)} 2x"><img src="fallback.svg" width="160" alt="picture"></picture>`,
      '![broken](broken.svg)',
      ...Array.from({ length: large ? 2800 : 30 }, (_, index) => `Paragraph ${index}: ` + 'reading content '.repeat(28))].join('\n\n');
    assert.equal(assessLargeDocument(text).windowedPreview, large);
    await page.evaluate(({ text, layout, language, appearance }) => {
      (window as any).__applyUiTheme(appearance, false);
      document.body.style.backgroundColor = 'var(--meo-background)';
      const controller = (window as any).__previewController;
      controller.setUiLanguage(language); controller.setAppearance(appearance); controller.setVisible(true);
      void controller.requestRender(text, { layout });
    }, { text, layout, language, appearance });
    const frame = await (await page.waitForSelector('.preview-frame'))!.contentFrame();
    assert.ok(frame);
    const waitImage = (alt: string, height?: number) => page.waitForFunction((alt, height) => {
      const image = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector<HTMLImageElement>(`img[alt="${alt}"]`);
      return image?.dataset.meoPreviewImageReady === 'true' && (height === undefined || image.naturalHeight === height);
    }, {}, alt, height);
    await waitImage('local');
    assert.equal(await frame.$eval('html', element => element.getAttribute('data-meo-preview-large-document')), String(large));
    assert.equal(messages.filter(message => message.type === 'requestPreviewRender').at(-1).window !== undefined, large);
    console.log(`Image actions ${large}/${layout}: loaded`);
    const buttons = 'img[alt="local"] + .meo-preview-image-actions > [role="button"]';
    assert.deepEqual(await frame.$$eval(buttons, nodes => nodes.map(node => node.getAttribute('aria-label'))), language === 'en'
      ? ['Refresh image', 'Open with system app', 'Fullscreen image'] : ['刷新图片', '使用系统应用打开', '全屏查看图片']);
    const clickAction = async (alt: string, index: number) => {
      const image = await frame.$(`img[alt="${alt}"]`); assert.ok(image);
      let box = await image.boundingBox(); assert.ok(box);
      const viewport = await (await page.$('.preview-frame'))!.boundingBox(); assert.ok(viewport);
      if (box.y + box.height <= viewport.y || box.y >= viewport.y + viewport.height) {
        await image.scrollIntoView(); box = await image.boundingBox(); assert.ok(box);
      }
      await page.mouse.move(box.x + box.width / 2, Math.max(viewport.y + 30, Math.min(box.y + box.height / 2, viewport.y + viewport.height - 30)));
      const action = await frame.$(`:is(img[alt="${alt}"], picture:has(img[alt="${alt}"]), a:has(img[alt="${alt}"])) + .meo-preview-image-actions > [role="button"]:nth-child(${index + 1})`);
      const point = await action!.boundingBox(); assert.ok(point);
      await page.mouse.click(point.x + point.width / 2, point.y + point.height / 2);
    };
    await clickAction('local', 1);
    await page.waitForFunction(() => (window as any).__previewMessages.some((message: any) => message.type === 'openImageExternally'));
    assert.equal(messages.filter(message => message.type === 'openImageExternally').at(-1).url, 'local.svg');
    await clickAction('linked', 2);
    assert.equal(await frame.$eval('img[alt="linked"]', image => image.closest('a')!.children.length), 1,
      'Image controls retain the authored link contents');
    assert.equal(messages.some(message => message.type === 'openLink'), false, 'Image actions must not activate the enclosing link');
    assert.deepEqual(await page.$$eval('.meo-md-image-fullscreen-controls button', nodes => nodes.map(node => node.getAttribute('aria-label'))), language === 'en'
      ? ['Zoom in', 'Zoom out', 'Reset zoom', 'Exit fullscreen'] : ['放大', '缩小', '重置缩放', '退出全屏']);
    const viewerSize = await page.$eval('.meo-md-image-fullscreen', node => ({ width: node.clientWidth, height: node.clientHeight }));
    assert.ok(viewerSize.width >= (layout === 'side' ? 610 : 990) && viewerSize.height >= 790);
    await page.click('.meo-md-image-fullscreen-controls button:first-child');
    assert.match(await page.$eval('.meo-md-image-fullscreen-img', node => (node as HTMLElement).style.transform), /scale\(1.25\)/);
    await page.screenshot({ path: `${output}/${large}-${layout}-${appearance}-fullscreen.png` });
    await page.keyboard.press('Escape');
    await frame.click('img[alt="linked"]');
    await page.waitForFunction(() => (window as any).__previewMessages.some((message: any) => message.type === 'openLink'));
    assert.equal(messages.filter(message => message.type === 'openLink').at(-1).href, 'https://example.com/image-link');
    console.log(`Image actions ${large}/${layout}: pointer fullscreen and links`);
    // Focused controls remain reachable without a pointer and fullscreen traps Tab.
    await frame.focus(`${buttons}:last-child`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.meo-md-image-fullscreen');
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.$eval('.meo-md-image-fullscreen-scrim', node => node.contains(document.activeElement)));
    }
    await page.keyboard.press('Escape');
    assert.ok(await frame.evaluate(() => document.activeElement?.matches('.meo-preview-image-actions > [role="button"]:last-child')));
    console.log(`Image actions ${large}/${layout}: keyboard and mode cleanup`);
    // Keep the preceding image partly visible while the reading anchor is below it.
    const delta = await frame.evaluate(() => document.querySelector<HTMLImageElement>('img[alt="local"]')!.getBoundingClientRect().bottom - 70);
    const frameBounds = await (await page.$('.preview-frame'))!.boundingBox(); assert.ok(frameBounds);
    await page.mouse.move(frameBounds.x + 50, frameBounds.y + 50);
    await page.mouse.wheel({ deltaY: delta });
    await page.evaluate(async () => { for (let index = 0; index < 12; index++) await new Promise(requestAnimationFrame); });
    await frame.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>('img[alt="local"]')!;
      (window as any).__oldImage = image;
      (window as any).__anchor = Array.from(document.querySelectorAll('p')).find(node => node.textContent?.startsWith('Reading anchor below image.'))!;
      (window as any).__anchorTop = (window as any).__anchor.getBoundingClientRect().top;
    });
    const renders = messages.filter(message => message.type === 'requestPreviewRender').length;
    hold = true; tall = true;
    const reloadRequest = page.waitForRequest(request => request.url().includes('meoReload='));
    await clickAction('local', 0);
    await reloadRequest;
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('img[alt="local"] + .meo-preview-image-actions > [aria-disabled="true"]'));
    assert.ok(await frame.evaluate(() => (window as any).__oldImage === document.querySelector('img[alt="local"]')),
      'Refresh retains the accepted image while its replacement is pending');
    await page.evaluate(() => {
      const scope = window as any, content = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow as any;
      scope.__frames = []; scope.__sampling = true;
      const sample = () => { if (!scope.__sampling) return; scope.__frames.push(content.__anchor.getBoundingClientRect().top); requestAnimationFrame(sample); }; sample();
    });
    hold = false; release();
    console.log(`Image actions ${large}/${layout}: refresh released`);
    try { await waitImage('local', 420); }
    catch (error) {
      console.error(await frame.evaluate(() => Array.from(document.querySelectorAll('img')).map(image => ({ html: image.outerHTML, width: image.naturalWidth, height: image.naturalHeight }))));
      console.error(errors); throw error;
    }
    const samples = await page.evaluate(async () => {
      for (let index = 0; index < 6; index++) await new Promise(requestAnimationFrame);
      const scope = window as any; scope.__sampling = false;
      return { before: (document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow as any).__anchorTop, frames: scope.__frames };
    });
    assert.ok(samples.frames.every((top: number) => Math.abs(top - samples.before) <= 1), JSON.stringify(samples));
    assert.equal(messages.filter(message => message.type === 'requestPreviewRender').length, renders, 'Refresh must not rerender Markdown');
    console.log(`Image actions ${large}/${layout}: refresh anchor`);
    fail = true;
    const failedRequest = page.waitForRequest(request => request.url().includes('meoReload='));
    await clickAction('local', 0);
    await failedRequest;
    try { await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('.meo-preview-image-actions [role="status"]')); }
    catch (error) {
      console.error('Failed refresh state', await frame.evaluate(() => ({ images: Array.from(document.querySelectorAll('img')).map(image => image.outerHTML),
        controls: Array.from(document.querySelectorAll('.meo-preview-image-actions')).map(node => ({ label: node.textContent, buttons: Array.from(node.children).map(button => button.getAttribute('aria-disabled')) })) })));
      console.error(errors); throw error;
    }
    assert.equal(await frame.$eval('img[alt="local"]', node => (node as HTMLImageElement).naturalHeight), 420, 'Failed refresh preserves the accepted image');
    fail = false; recovered = true;
    await clickAction('broken', 0);
    await waitImage('broken');
    console.log(`Image actions ${large}/${layout}: failed refresh and retry`);
    assert.equal(await frame.$eval('img[alt="html"]', node => node.getAttribute('width')), '160');
    await clickAction('picture', 0);
    try { await waitImage('picture', 420); }
    catch (error) {
      console.error('Picture refresh', await frame.$eval('picture', node => ({ html: node.outerHTML,
        current: node.querySelector('img')!.currentSrc, height: node.querySelector('img')!.naturalHeight })));
      console.error(errors); throw error;
    }
    const picture = await frame.$eval('picture', node => ({ source: node.querySelector('source')!.getAttribute('srcset'),
      current: node.querySelector('img')!.currentSrc, width: node.querySelector('img')!.getAttribute('width') }));
    assert.match(picture.source!, /meoReload=\d+ 1x, .*meoReload=\d+ 2x/);
    assert.match(picture.current, /picture(?:-2x)?\.svg\?meoReload=/);
    assert.equal(picture.width, '160');
    await clickAction('html', 1);
    assert.equal(await frame.$eval('img[alt="html"] + .meo-preview-image-actions > [role="button"]:nth-child(2)', node => node.getAttribute('aria-label')),
      language === 'en' ? 'Open image in browser' : '在浏览器中打开图片');
    await page.screenshot({ path: `${output}/${large}-${layout}-${appearance}-controls.png` });
    if (large) {
      await page.evaluate(() => (window as any).__previewController.restoreTopLine(4000));
      await page.waitForFunction(() => !document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('img[alt="local"]'));
      assert.ok(messages.some(message => message.type === 'requestPreviewDocument'), 'Windowed resource requests must actually run');
      assert.equal(await frame.$$eval('.meo-preview-image-actions', nodes => nodes.length), 0, 'Evicted images release their controls');
      await page.evaluate(() => (window as any).__previewController.restoreTopLine(1));
      await waitImage('local');
      assert.equal(await frame.$$eval('img[alt="local"] + .meo-preview-image-actions', nodes => nodes.length), 1);
    }
    await clickAction('local', 2);
    await page.evaluate(() => (window as any).__previewController.setVisible(false));
    assert.equal(await page.$('.meo-md-image-fullscreen'), null);
    await page.evaluate(() => (window as any).__previewController.setVisible(true));
    if (large && layout === 'full') {
      // A decoded image can be awaiting the shared reading budget when Preview
      // is hidden. Cancellation must retain that result for the next reveal.
      lateImage = new Promise<void>(resolve => { releaseLateImage = resolve; });
      await page.evaluate(text => {
        void (window as any).__previewController.requestRender('![late](late.svg)\n\n' + text, { layout: 'full' });
      }, text);
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector('img[alt="late"]'));
      await frame.$eval('img[alt="late"]', image => image.scrollIntoView({ block: 'center' }));
      await frame.evaluate(() => {
        const scope = window as any, decode = HTMLImageElement.prototype.decode;
        scope.__restoreImageDecode = () => { HTMLImageElement.prototype.decode = decode; };
        HTMLImageElement.prototype.decode = function() {
          return decode.call(this).then(() => { if (this.alt === 'late') scope.__lateImageDecoded = true; });
        };
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71, button: 0, clientX: 30, clientY: 60 }));
      });
      releaseLateImage();
      await page.waitForFunction(() => (document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow as any).__lateImageDecoded,
        { polling: 10 });
      assert.equal(await frame.$eval('img[alt="late"]', image => (image as HTMLElement).dataset.meoPreviewImageReady), undefined,
        'A held reading gesture must defer the decoded image commit');
      await page.evaluate(() => (window as any).__previewController.setVisible(false));
      await waitImage('late');
      await page.evaluate(() => (window as any).__previewController.setVisible(true));
      await waitImage('late');
      await frame.evaluate(() => (window as any).__restoreImageDecode());
      console.log('Pending decoded image survives reading cancellation and reveal');
    }
    await page.evaluate(() => (window as any).__previewController.dispose());
    assert.equal(await page.$('.meo-md-image-fullscreen'), null);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS image actions: ${large ? 'windowed' : 'ordinary'} ${layout} ${language} ${appearance}`);
  }
} catch (error) { primaryError = error; }
finally {
  release(); releaseLateImage(); server.stop(true);
  if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError);
}
