import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const text = Array.from({ length: 40 }, (_, index) => `## Section ${index}\n\n${'Reading paragraph. '.repeat(50)}\n`).join('\n');
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 760 });
  // VS Code can create a webview while its editor tab has no layout boxes.
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><style id="hidden-preview">.preview-host{display:none!important}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.exposeFunction('__render', (message: any) => message.type === 'requestPreviewRender' ? {
    type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
      markdownText: message.text, sourceDocumentPath: 'C:/tmp/outline.md', uiLanguage: 'en', styleEnvironment: message.environment, preset: message.preset
    }) }
  } : null);
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return {}},setState(){},postMessage(message){window.__render(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///outline.md', text, version: 1, savedRevision: { version: 1, text },
    diagnostics: [], mode: 'preview', uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark',
    previewFontFamily: 'Arial', previewSourceColoring: false, previewShowComments: false, editorAppearance: 'dark',
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
    fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
    findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: true, outlineWidth: 260, vscodeTheme: null
  } })), text);
  await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 40);
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.evaluate(() => { document.querySelector('#hidden-preview')!.remove(); });
  await new Promise(resolve => setTimeout(resolve, 500));
  const read = () => page.evaluate(() => ({
    total: document.querySelectorAll('.outline-item').length,
    visible: document.querySelectorAll('.outline-item.is-visible').length,
    height: document.querySelector('.outline-visible-range')?.getBoundingClientRect().height ?? 0
  }));
  const initial = await read();
  assert.ok(initial.visible > 0 && initial.visible < 6 && initial.height < 150, `Outline must recover the viewport after a hidden tab becomes visible: ${JSON.stringify(initial)}`);
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('h2[data-source-line="61"]')!.scrollIntoView());
  await new Promise(resolve => setTimeout(resolve, 100));
  const scrolled = await read();
  assert.ok(scrolled.visible > 0 && scrolled.visible < 6 && scrolled.height < 150, JSON.stringify(scrolled));
  await page.close();

  for (const large of [false, true]) {
    const footnoteText = '# Start\n\nEarly reference[^early].\n\n[^early]: Early definition.\n\n'
      + (large ? 'Additional body paragraph.\n\n'.repeat(4_100) : '')
      + Array.from({ length: 30 }, (_, index) => `## Chapter ${index + 1}\n\nBody paragraph one.\n\nBody paragraph two.\n\n`).join('')
      + 'Final reference[^late].\n\n[^late]: Last definition.\n\n'
      + Array.from({ length: 45 }, (_, index) => `    Continued footnote paragraph ${index}.\n\n`).join('');
    assert.equal(assessLargeDocument(footnoteText).windowedPreview, large);
    for (const split of [false, true]) {
      const label = `${large ? 'windowed' : 'ordinary'} ${split ? 'split' : 'full'} Preview`;
      const notePage = await browser.newPage();
      const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
      let windowRequests = 0;
      await notePage.setViewport({ width: 1400, height: 760 });
      await notePage.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await notePage.addStyleTag({ path: 'webview/src/styles.css' });
      await notePage.exposeFunction('__render', async (message: any) => {
        if (message.type === 'requestPreviewRender') {
          assert.equal(Boolean(message.window), large, `${label}: actual rendering policy`);
          const options = { markdownText: message.text, sourceDocumentPath: '/fixture/footnote-outline.md',
            uiLanguage: 'en' as const, styleEnvironment: message.environment, preset: message.preset };
          let value;
          if (message.window) {
            windowRequests++;
            const parsed = createPreviewDocument(message.requestId, options);
            documents.set(message.requestId, parsed);
            value = parsed.open(message.window.anchorLine);
          } else value = exportRuntime.renderPreviewDocument(options);
          return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } };
        }
        if (message.type === 'requestPreviewDocument') return {
          type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
          result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) }
        };
        return null;
      });
      await notePage.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return {sourcePreviewScrollSyncEnabled:false}},setState(){},postMessage(message){window.__render(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
      await notePage.addScriptTag({ content: bundle });
      await notePage.evaluate(({ text, split }) => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///footnote-outline.md', text, version: 1, savedRevision: { version: 1, text },
        diagnostics: [], mode: split ? 'source' : 'preview', uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark',
        previewFontFamily: 'Arial', previewSourceColoring: false, editorAppearance: 'dark', largeDocumentOptimizationEnabled: true,
        gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: true, outlineWidth: 260,
        restoreReadingPositionOnOpen: false, vscodeTheme: null
      } })), { text: footnoteText, split });
      if (split) {
        await notePage.waitForFunction(() => !document.querySelector('.meo-preload-toolbar')
          && document.querySelector<HTMLButtonElement>('.source-preview-button')?.disabled === false);
        await notePage.click('.source-preview-button');
      }
      await notePage.waitForFunction(() => document.querySelectorAll('.outline-item').length === 31
        && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main')
        && document.querySelector<HTMLElement>('.preview-loading')?.hidden
        && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden');
      assert.equal(windowRequests > 0, large, `${label}: windowed renderer witness`);
      if (large) assert.ok(await notePage.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
        .contentDocument!.querySelector('[data-meo-preview-footnotes]')?.hasAttribute('data-meo-preview-gap')),
      `${label}: unloaded footnotes retain their separate outline identity`);
      const sourceHighlights = await notePage.$$eval('.outline-item.is-visible', items => items.map(item => item.textContent));
      await notePage.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        doc.scrollingElement!.scrollTop = doc.scrollingElement!.scrollHeight;
      });
      await notePage.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')!
        .contentDocument!.querySelector('.footnote-item'));
      // Fit the boundary into the reading viewport, even when an estimated tail
      // was replaced by the actual footer on the windowed rendering path.
      await notePage.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const footer = doc.querySelector<HTMLElement>('section.footnotes')!;
        doc.scrollingElement!.scrollTop += footer.getBoundingClientRect().top - 120;
      });
      await notePage.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const footer = doc.querySelector('section.footnotes')?.getBoundingClientRect();
        return footer && footer.top > 50 && footer.top < 200;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const mixed = await notePage.evaluate(() => [...document.querySelectorAll('.outline-item.is-visible')].map(item => item.textContent));
      // Split mode's outline follows Source. Scrolling its independent Preview
      // must not replace Source's existing chapter highlights.
      assert.deepEqual(mixed, split ? sourceHighlights : ['Chapter 30'],
        `${label}: relocated notes must not change the owning body viewport's highlights`);
      await notePage.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        doc.scrollingElement!.scrollTop = doc.scrollingElement!.scrollHeight;
      });
      await notePage.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const footer = doc.querySelector('section.footnotes')?.getBoundingClientRect();
        return footer && footer.top < 0 && ![...doc.querySelectorAll('h1,h2,p[data-source-line]')].some(element => {
          if (element.closest('section.footnotes')) return false;
          const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight;
        });
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (split) {
        assert.deepEqual(await notePage.$$eval('.outline-item.is-visible', items => items.map(item => item.textContent)),
          sourceHighlights, `${label}: Preview footer preserves Source outline ownership`);
      } else {
        assert.equal(await notePage.$eval('.outline-visible-range', element => (element as HTMLElement).hidden), true,
          `${label}: a footnotes-only viewport has no body highlight`);
        assert.equal(await notePage.$$eval('.outline-item.is-visible', elements => elements.length), 0, label);
      }
      if (process.env.MEO_TEST_SCREENSHOTS) {
        const directory = process.env.MEO_TEST_SCREENSHOTS;
        await import('node:fs/promises').then(fs => fs.mkdir(directory, { recursive: true }));
        await notePage.screenshot({ path: `${directory}/footnote-outline-footer-${large ? 'large' : 'ordinary'}-${split ? 'split' : 'full'}.png` });
      }
      const finalHeadingLine = footnoteText.split('\n').findIndex(line => line === '## Chapter 30') + 1;
      const finalHeadingFrom = split ? footnoteText.indexOf('## Chapter 30') : finalHeadingLine;
      await notePage.locator(`.outline-item[data-heading-from="${finalHeadingFrom}"]`).click()
        .catch(error => { throw new Error(`${label}: return from footnotes through the outline`, { cause: error }); });
      await notePage.waitForFunction(() => [...document.querySelectorAll('.outline-item.is-visible')]
        .some(item => item.textContent === 'Chapter 30'));
      if (process.env.MEO_TEST_SCREENSHOTS) {
        const directory = process.env.MEO_TEST_SCREENSHOTS;
        await import('node:fs/promises').then(fs => fs.mkdir(directory, { recursive: true }));
        await notePage.screenshot({ path: `${directory}/footnote-outline-${large ? 'large' : 'ordinary'}-${split ? 'split' : 'full'}.png` });
      }
      await notePage.close();
    }
  }
  console.log('Preview outline viewport and hidden-tab recovery passed.');
} finally {
  await browser.close();
}
