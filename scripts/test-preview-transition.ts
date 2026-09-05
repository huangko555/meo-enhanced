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
  let releaseInitialRender!: () => void;
  const initialRender = new Promise<void>(resolve => { releaseInitialRender = resolve; });
  let holdInitialRender = true;
  await page.exposeFunction('__renderPreview', async (message: any) => {
    if (message.type === 'resolveImageSrc') {
      assert.equal(message.delivery, 'embedded', 'Preview iframe images must request embedded delivery');
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
