import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const largeDocument = process.argv.includes('--large');

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
const assertLateLayout = async (imageInside: boolean): Promise<void> => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 760 });
  let imageResolutionRequested = false;
  let releaseImageResolution = () => {};
  const imageResolutionGate = new Promise<void>(resolve => {
    releaseImageResolution = resolve;
  });
  await page.exposeFunction('__renderSourcePreviewLateLayout', async (message: any) => {
    if (message.type === 'resolveImageSrc') {
      imageResolutionRequested = true;
      await imageResolutionGate;
      return {
        type: 'resolvedImageSrc',
        requestId: message.requestId,
        result: {
          ok: true,
          value: {
            resolvedUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="240"%3E%3Crect width="400" height="240" fill="%23789"/%3E%3C/svg%3E'
          }
        }
      };
    }
    if (message.type !== 'requestPreviewRender') return null;
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: {
        ok: true,
        value: exportRuntime.renderPreviewDocument({
          markdownText: message.text,
          sourceDocumentPath: 'C:/tmp/source-preview-late-layout.md',
          uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment
        })
      }
    };
  });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderSourcePreviewLateLayout(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });

  const anchorText = 'Stable paragraph after late image';
  const text = [
    ...Array.from({ length: 25 }, (_, index) => `Before image paragraph ${index + 1}.`),
    ...(imageInside ? [anchorText] : []),
    '![Late image](https://preview-layout.test/late.svg)',
    ...Array.from({ length: 2 }, (_, index) => `Between image and anchor ${index + 1}.`),
    ...(!imageInside ? [anchorText] : []),
    ...Array.from({ length: largeDocument ? 4_100 : 40 }, (_, index) => `After anchor paragraph ${index + 1}.`)
  ].join('\n\n');
  const anchorLine = text.slice(0, text.indexOf(anchorText)).split('\n').length;
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///source-preview-late-layout.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
    uiLanguagePreference: 'auto', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
    previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
    restoreReadingPositionOnOpen: false, vscodeTheme: null
  } })), text);
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLElement>('button[data-mode=source]');
    return button?.offsetParent !== null && getComputedStyle(button).visibility === 'visible';
  });
  await page.click('.line-jump-input');
  await page.keyboard.type(String(anchorLine));
  await page.keyboard.press('Enter');
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await page.click('.source-preview-button');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return !document.querySelector<HTMLElement>('.preview-host')?.hidden
      && Boolean(frame?.contentDocument?.querySelector('main.meo-export-doc'));
  });
  for (let attempt = 0; attempt < 100 && !imageResolutionRequested; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(imageResolutionRequested, 'The late image request must be held before the layout probe');
  await page.waitForFunction(anchorText => document.querySelector<HTMLIFrameElement>('.preview-frame')
    ?.contentDocument?.body.textContent?.includes(anchorText), {}, anchorText);
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')
    ?.contentDocument?.documentElement.dataset.meoPreviewLargeDocument), String(largeDocument));
  // Establish the actual linked top before releasing the image. A centered
  // caret alone can leave that image inside the viewport in either fixture.
  await page.locator('.line-jump-input').fill(String(anchorLine));
  await page.keyboard.press('Enter');
  const target = await page.evaluate(line => {
    const view = (document.querySelector('.cm-content') as any).cmTile.root.view;
    const rect = view.scrollDOM.getBoundingClientRect();
    return { delta: view.lineBlockAt(view.state.doc.line(line).from).top - view.scrollDOM.scrollTop,
      x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, anchorLine);
  await page.mouse.move(target.x, target.y);
  await page.mouse.wheel({ deltaY: target.delta });
  await page.waitForFunction(anchorText => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const anchor = [...doc.querySelectorAll('p')].find(element => element.textContent === anchorText);
    return anchor && Math.abs(anchor.getBoundingClientRect().top) <= 2;
  }, { timeout: 2000 }, anchorText).catch(async error => {
    console.error('Late-image setup', await page.evaluate(anchorText => ({
      mode: document.querySelector('.editor-root')?.getAttribute('data-mode'),
      source: document.querySelector('.cm-scroller')?.scrollTop,
      synced: document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed'),
      top: [...document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelectorAll('p')]
        .find(element => element.textContent === anchorText)?.getBoundingClientRect().top
    }), anchorText));
    throw error;
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  const sourceTop = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(imageInside => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const frameDocument = frame.contentDocument!;
    const readingY = imageInside ? 0 : (frame.contentWindow?.innerHeight ?? 0) / 3;
    const entries = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(entry => entry.rect.height > 0);
    const candidate = entries
      .filter(entry => entry.rect.top <= readingY && entry.rect.bottom >= readingY)
      .sort((left, right) => left.rect.height - right.rect.height)[0]
      ?? entries.sort((left, right) => (
        Math.abs(left.rect.top - readingY) - Math.abs(right.rect.top - readingY)
      ))[0];
    if (!candidate) throw new Error('The Preview reading band must have a semantic source element');
    const progress = Math.max(0, Math.min(
      1,
      (readingY - candidate.rect.top) / candidate.rect.height
    ));
    const samples: number[] = [];
    let active = true;
    const sample = () => {
      if (!active) return;
      const rect = candidate.element.getBoundingClientRect();
      samples.push(rect.top + rect.height * progress);
      requestAnimationFrame(sample);
    };
    (window as typeof window & { __lateLayoutProbe?: { samples: number[]; stop(): void } }).__lateLayoutProbe = {
      samples,
      stop: () => { active = false; }
    };
    requestAnimationFrame(sample);
  }, imageInside);
  releaseImageResolution();
  await page.waitForFunction(() => Array.from(
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.images ?? []
  ).some(image => image.naturalWidth === 400 && image.naturalHeight === 240));
  await page.evaluate(() => new Promise<void>(resolve => {
    let remaining = 8;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  const samples = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __lateLayoutProbe: { samples: number[]; stop(): void };
    }).__lateLayoutProbe;
    probe.stop();
    return probe.samples;
  });
  assert.ok(samples.length >= 2, JSON.stringify(samples));
  assert.ok(
    Math.max(...samples) - Math.min(...samples) <= 1,
    `A late Preview layout commit must preserve the visible semantic anchor: ${JSON.stringify(samples)}`
  );
  assert.equal(await page.$eval('.cm-scroller', element => element.scrollTop), sourceTop,
    'A late Preview image must not move its Source owner');
  console.log(`Source Preview late-layout anchor checks passed (${largeDocument ? 'large' : 'ordinary'} document, image ${imageInside ? 'inside' : 'above'} viewport)`);
  await page.close();
};
try {
  await assertLateLayout(false);
  await assertLateLayout(true);
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
