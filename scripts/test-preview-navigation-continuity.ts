import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const largeDocument = process.argv.includes('--large');
const selectedCase = process.argv.find(argument => argument.startsWith('--case='))?.slice(7);
const markdown = '[Jump to Section 12](#section-12)\n\n' + Array.from({ length: largeDocument ? 240 : 24 }, (_, section) =>
  `## Section ${section + 1}\n\n` + Array.from({ length: 8 }, (_, paragraph) =>
    `Paragraph ${section + 1}-${paragraph + 1}: ` + 'reading content '.repeat(18)
  ).join('\n\n')
).join('\n\n');
const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const mode of ['live', 'source'] as const) {
    for (const navigation of ['outline', 'fragment', 'top', 'unchanged'] as const) {
      if (selectedCase && selectedCase !== `${mode}:${navigation}`) continue;
      const label = `${mode}: ${navigation}`;
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1200, height: 800 });
        await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
        await page.addStyleTag({ path: 'webview/src/styles.css' });
        await page.exposeFunction('__renderNavigationPreview', (message: any) => {
          if (message.type !== 'requestPreviewRender') return null;
          return {
            type: 'previewRenderResult', requestId: message.requestId,
            result: { ok: true, value: exportRuntime.renderPreviewDocument({
              markdownText: message.text, sourceDocumentPath: 'C:/tmp/preview-navigation.md',
              uiLanguage: message.uiLanguage, styleEnvironment: message.environment
            }) }
          };
        });
        await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderNavigationPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(({ text, mode }) => {
          window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'init', documentId: 'file:///preview-navigation.md', text, version: 1,
            savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'en',
            sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '',
            previewSourceColoring: true, editorAppearance: 'dark',
            gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
            diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
            contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
            outlinePosition: mode === 'live' ? 'right' : 'left', outlineVisible: true, outlineWidth: 260,
            restoreReadingPositionOnOpen: false, vscodeTheme: null
          } }));
        }, { text: markdown, mode });
        if (largeDocument && mode === 'live') {
          await page.waitForSelector('.cm-content');
          await page.click(`button[data-mode="${mode}"]`);
        }
        await page.waitForFunction(mode => Boolean(document.querySelector(`.cm-editor.meo-mode-${mode}`))
          && !document.querySelector('.editor-wrapper')?.classList.contains('meo-preload-editor-shell'), {}, mode);
        if (largeDocument && mode === 'source') {
          await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 240
            && document.querySelector('.outline-content')?.getAttribute('aria-busy') === 'false',
          { timeout: selectedCase ? 5_000 : 30_000 });
        }
        if (navigation === 'top' || navigation === 'unchanged') {
          await page.waitForSelector('.outline-item[data-tooltip="Section 12"]', { timeout: selectedCase ? 5_000 : 30_000 });
          await page.click('.outline-item[data-tooltip="Section 12"]');
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        const previousScroll = await page.$eval('.cm-scroller', element => element.scrollTop);
        await page.click('[data-mode="preview"]');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview'
          && document.querySelector<HTMLElement>('.preview-status')?.hidden === true);
        // Parent timers remain executable while the Preview iframe is script-sandboxed.
        await new Promise(resolve => setTimeout(resolve, 250));
        const frame = await (await page.$('.preview-frame'))!.contentFrame();
        assert.ok(frame);
        if (navigation === 'outline') {
          await page.waitForSelector('.outline-item[data-tooltip="Section 12"]');
          await page.click('.outline-item[data-tooltip="Section 12"]');
        }
        if (navigation === 'fragment') {
          await frame.focus('a[data-meo-preview-href="#section-12"]');
          await page.keyboard.press('Enter');
        }
        if (navigation === 'top') await page.click('.preview-host .document-scroll-top');
        await new Promise(resolve => setTimeout(resolve, 250));
        const expectedHeading = navigation === 'top' ? 'Section 1' : 'Section 12';
        const previewWitness = await frame.evaluate(headingText => {
          const heading = Array.from(document.querySelectorAll('h2')).find(element => element.textContent === headingText)!;
          const rect = heading.getBoundingClientRect();
          return { visible: rect.bottom > 0 && rect.top < innerHeight, scroll: scrollY };
        }, expectedHeading);
        if (navigation !== 'unchanged') assert.ok(previewWitness.visible, `${label}: Preview did not reach ${expectedHeading}`);
        if (navigation === 'top') assert.equal(previewWitness.scroll, 0);
        // The only subsequent click is the mode button, never the Preview body.
        await page.click(`[data-mode="${mode}"]`);
        await page.waitForFunction(mode => document.querySelector<HTMLElement>('#app')?.dataset.mode === mode
          && document.querySelector<HTMLElement>('.preview-host')?.hidden === true, {}, mode);
        await new Promise(resolve => setTimeout(resolve, 250));
        const result = await page.evaluate(async headingText => {
          const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
          const samples: Array<{ visible: boolean; scroll: number }> = [];
          for (let frame = 0; frame < 8; frame += 1) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const heading = Array.from(scroller.querySelectorAll('.cm-line'))
              .find(element => element.textContent?.endsWith(headingText));
            const rect = heading?.getBoundingClientRect();
            const viewport = scroller.getBoundingClientRect();
            samples.push({ visible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom), scroll: scroller.scrollTop });
          }
          return samples;
        }, expectedHeading);
        if (navigation === 'unchanged') {
          assert.ok(result.every(sample => Math.abs(sample.scroll - previousScroll) <= 1), `${label}: unmodified mode roundtrip moved the viewport`);
        } else {
          assert.ok(result.every(sample => sample.visible), `${label}: ${expectedHeading} lost after return: ${JSON.stringify(result)}`);
        }
        console.log(`PASS ${label}`);
      } catch (error) {
        console.error(label, await page.evaluate(() => ({
          mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
          outline: Array.from(document.querySelectorAll<HTMLElement>('.outline-item')).slice(0, 16).map(item => item.dataset.tooltip),
          outlineCount: document.querySelectorAll('.outline-item').length,
          editor: document.querySelector('.editor-host > .cm-editor')?.className
        })));
        throw error;
      } finally {
        await page.close();
      }
    }
  }
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError !== undefined) await closeTestBrowser(browser, primaryError);
  else await closeTestBrowser(browser);
}
console.log('Preview navigation continuity checks passed');
