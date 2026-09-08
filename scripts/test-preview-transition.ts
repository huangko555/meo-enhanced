import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  const pendingRemoteImages: Array<() => Promise<void>> = [];
  let holdRemoteImages = true;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!request.url().startsWith('https://preview-image.test/')) {
      void request.continue();
      return;
    }
    const respond = () => request.respond({ status: 200, contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64') });
    if (holdRemoteImages) pendingRemoteImages.push(respond);
    else void respond();
  });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  let failRender = false;
  let holdLiveImageResolution = false;
  const pendingLiveImageResolutions: Array<() => void> = [];
  let releaseInitialRender!: () => void;
  const initialRender = new Promise<void>(resolve => { releaseInitialRender = resolve; });
  let holdInitialRender = true;
  await page.exposeFunction('__renderPreview', async (message: any) => {
    if (message.type === 'resolveImageSrc') {
      if (message.delivery !== 'embedded' && holdLiveImageResolution) {
        await new Promise<void>((resolve) => pendingLiveImageResolutions.push(resolve));
      }
      return {
        type: 'resolvedImageSrc',
        requestId: message.requestId,
        result: {
          ok: true,
          value: {
            resolvedUrl: message.url.startsWith('https://preview-image.test/')
              ? message.url : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
          }
        }
      };
    }
    if (message.type !== 'requestPreviewRender') return null;
    if (holdInitialRender) await initialRender;
    if (failRender) return { type: 'previewRenderResult', requestId: message.requestId,
      result: { ok: false, error: { code: 'operation-failed', message: 'Rendering unavailable' } } };
    return {
      type: 'previewRenderResult', requestId: message.requestId,
      result: { ok: true, value: exportRuntime.renderPreviewDocument({
        markdownText: message.text, sourceDocumentPath: 'C:/tmp/preview-transition.md',
        uiLanguage: message.uiLanguage, styleEnvironment: message.environment
      }) }
    };
  });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = [
    ...Array.from({ length: 90 }, (_, i) => `HTML 前固定参照行 ${i + 1}`),
    [
      '<table>',
      '  <thead><tr><th>项目</th><th>短内容</th><th>长内容（编辑此列以制造换行和高度变化）</th></tr></thead>',
      '  <tbody>',
      '    <tr><td>模式切换</td><td>预览</td><td>Source → Preview → Live 首帧稳定性</td></tr>',
      '    <tr><td>定位</td><td>锚点</td><td>表格上方退出源码时不应挤压下方图片</td></tr>',
      '  </tbody>',
      '</table>'
    ].join('\n'),
    'HTML 测试区结束固定锚点',
    '![Markdown local](images/markdown-local.png)',
    '<img src="images/html-local.png" alt="HTML local">',
    '![Markdown remote](https://preview-image.test/markdown.gif)',
    '<img src="https://preview-image.test/html.gif" alt="HTML remote">',
    ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: visible text throughout the preview transition.`)
  ].join('\n\n');
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///preview-transition.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
    sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
  } })), text);
  await page.waitForSelector('.cm-content');
  const preloadWidth = await page.$eval('.preview-frame', frame => frame.getBoundingClientRect().width);
  for (const phase of ['pending-render', 'cached']) {
    const cdp = await page.createCDPSession();
    const frames: string[] = [];
    cdp.on('Page.screencastFrame', event => {
      frames.push(event.data);
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await new Promise(resolve => setTimeout(resolve, 100));
    await page.click('button[data-mode="preview"]');
    if (phase === 'pending-render') {
      const pending = await page.evaluate(() => {
        const editor = document.querySelector<HTMLElement>('.editor-host')!;
        const preview = document.querySelector<HTMLElement>('.preview-host')!;
        return { covered: editor.hasAttribute('data-preview-cover'), displayed: getComputedStyle(editor).display !== 'none',
          editorInert: editor.inert, previewInert: preview.inert };
      });
      assert.deepEqual(pending, { covered: true, displayed: true, editorInert: true, previewInert: false },
        'An in-flight first render must keep the previous content painted without accepting edits');
      holdInitialRender = false;
      releaseInitialRender();
    }
    await page.waitForFunction(() =>
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Paragraph 39')
      && !document.querySelector('.editor-host')?.hasAttribute('data-preview-cover')
    , { timeout: 5000 });
    // Text must become readable while the network image requests are unresolved.
    // Release them only after the previous-surface cover is gone.
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      frame.contentDocument?.images[0]?.scrollIntoView({ block: 'center' });
    });
    holdRemoteImages = false;
    await Promise.all(pendingRemoteImages.splice(0).map(respond => respond()));
    await page.waitForFunction(() => {
      const images = Array.from(
        document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.images ?? []
      );
      return images.length === 4
        && images.every(image => image.complete && image.naturalWidth === 1)
        && images.every(image => !image.hasAttribute('data-meo-deferred-image-src'));
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
    // DOM visibility alone misses the blank compositor frame between two surfaces.
    const inkCounts = await page.evaluate(async frames => {
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 600;
      const context = canvas.getContext('2d')!;
      const counts: number[] = [];
      for (const frame of frames) {
        const image = new Image();
        await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; image.src = `data:image/png;base64,${frame}`; });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(100, 150, 550, 250).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 140 && pixels[i + 1]! > 140 && pixels[i + 2]! > 140) ink++;
        counts.push(ink);
      }
      return counts;
    }, frames);
    assert.ok(inkCounts.length >= 2, `${phase}: screencast must capture the transition`);
    assert.ok(inkCounts.every(count => count > 100), `${phase}: blank painted frame: ${inkCounts}`);
    await page.click('button[data-mode="live"]');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(preloadWidth > 100, 'Background preview must have reading width before activation');
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button[data-mode="preview"]')!.click();
    document.querySelector<HTMLButtonElement>('button[data-mode="live"]')!.click();
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  const cancelled = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    const preview = document.querySelector<HTMLElement>('.preview-host')!;
    return { editorVisible: !editor.hidden, editorInert: editor.inert,
      covered: editor.hasAttribute('data-preview-cover'), previewHidden: preview.hidden, previewInert: preview.inert };
  });
  assert.deepEqual(cancelled, { editorVisible: true, editorInert: false, covered: false, previewHidden: true, previewInert: true },
    'Late paint readiness must not cover or disable an editor after switching back');

  await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const image = document.querySelector<HTMLElement>('.meo-md-image-img')!;
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += image.getBoundingClientRect().top - viewport.top - 120;
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.click('button[data-mode="source"]');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden);
  holdLiveImageResolution = true;
  const liveRevealTrace = await page.evaluate(async () => {
    const preview = document.querySelector<HTMLElement>('.preview-host')!;
    const samples = [{ hidden: preview.hidden }];
    document.querySelector<HTMLButtonElement>('button[data-mode="live"]')!.click();
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push({ hidden: preview.hidden });
    }
    return samples;
  });
  const firstHiddenFrame = liveRevealTrace.findIndex((sample) => sample.hidden);
  assert.ok(
    firstHiddenFrame === -1 || firstHiddenFrame >= 3,
    `Preview cover must remain through two Live layout observations: ${JSON.stringify(liveRevealTrace)}`
  );
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-host')?.hidden);
  const pendingLiveReveal = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    const preview = document.querySelector<HTMLElement>('.preview-host')!;
    const liveImages = Array.from(editor.querySelectorAll<HTMLImageElement>('.meo-md-image-img'));
    return {
      editorHidden: editor.hidden,
      editorInert: editor.inert,
      previewHidden: preview.hidden,
      previewInert: preview.inert,
      liveImageCount: liveImages.length,
      liveImagesReady: liveImages.every((image) => image.complete && image.naturalWidth > 0),
      tableWidths: Array.from(
        editor.querySelectorAll<HTMLElement>('.meo-md-html-block table thead th'),
        (cell) => cell.getBoundingClientRect().width
      ),
      firstImageTop: liveImages[0]?.getBoundingClientRect().top ?? null
    };
  });
  assert.deepEqual({
    ...pendingLiveReveal,
    tableWidths: undefined,
    firstImageTop: undefined
  }, {
    editorHidden: false,
    editorInert: false,
    previewHidden: true,
    previewInert: true,
    liveImageCount: 2,
    liveImagesReady: true,
    tableWidths: undefined,
    firstImageTop: undefined
  }, 'A recent Source → Preview → Live cycle must reuse decoded images before the first Live paint');
  await page.evaluate(async () => {
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  const settledLiveLayout = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    const liveImages = Array.from(editor.querySelectorAll<HTMLImageElement>('.meo-md-image-img'));
    return {
      tableWidths: Array.from(
        editor.querySelectorAll<HTMLElement>('.meo-md-html-block table thead th'),
        (cell) => cell.getBoundingClientRect().width
      ),
      firstImageTop: liveImages[0]?.getBoundingClientRect().top ?? null
    };
  });
  assert.deepEqual(
    pendingLiveReveal.tableWidths.map((width) => Math.round(width)),
    settledLiveLayout.tableWidths.map((width) => Math.round(width)),
    'Live must not expose provisional table column widths after the Preview cover is removed'
  );
  assert.equal(pendingLiveReveal.tableWidths.length, 3, 'The Live stability fixture must include its HTML table');
  assert.ok(
    pendingLiveReveal.firstImageTop !== null && settledLiveLayout.firstImageTop !== null
      && Math.abs(pendingLiveReveal.firstImageTop - settledLiveLayout.firstImageTop) <= 1,
    `Live must not expose a provisional vertical anchor after the Preview cover is removed: ${JSON.stringify({ pendingLiveReveal, settledLiveLayout })}`
  );
  assert.equal(pendingLiveImageResolutions.length, 0, 'warm Live image resources must not resolve or load again');
  holdLiveImageResolution = false;
  pendingLiveImageResolutions.splice(0).forEach((release) => release());
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-host')?.hidden);
  assert.deepEqual(await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    return { hidden: editor.hidden, inert: editor.inert };
  }), { hidden: false, inert: false });

  await page.click('button[data-mode="source"]');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden);
  holdLiveImageResolution = true;
  const timeoutRevealStartedAt = Date.now();
  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-host')?.hidden, { timeout: 1000 });
  const timeoutRevealElapsed = Date.now() - timeoutRevealStartedAt;
  assert.ok(
    timeoutRevealElapsed <= 260,
    `Live reveal must not wait indefinitely for slow images: ${timeoutRevealElapsed}ms`
  );
  holdLiveImageResolution = false;
  pendingLiveImageResolutions.splice(0).forEach((release) => release());
  failRender = true;
  await page.click('.cm-content');
  await page.keyboard.type('changed');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => {
    const status = document.querySelector<HTMLElement>('.preview-status');
    return status && !status.hidden && !document.querySelector('.editor-host')?.hasAttribute('data-preview-cover');
  });
  assert.equal(await page.$eval('.editor-host', element => (element as HTMLElement).hidden), true,
    'Render failure must release the previous surface and expose the error');
  console.log('Preview transition paint and preloaded layout checks passed');
} finally {
  await browser.close();
}
