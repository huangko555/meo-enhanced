import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-native-scroll-progress-'));
const plain = Array.from({ length: 300 }, (_, index) => `Reading line ${index + 1}`).join('\n');
const rich = [
  ...Array.from({ length: 36 }, (_, index) => `Before line ${index + 1}`), '',
  '| Row | Wrapped content |', '| --- | --- |',
  ...Array.from({ length: 32 }, (_, index) => `| ${index + 1} | ${'wrapped content '.repeat(12)}<br>second line |`), '',
  '```typescript', ...Array.from({ length: 32 }, (_, index) => `const value${index} = ${index};`), '```', '',
  '<div><p>HTML reading block</p></div>', '',
  ...Array.from({ length: 150 }, (_, index) => `After line ${index + 1}`)
].join('\n');

async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(async count => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-production-live-scroll-integrity-entry.ts')],
  outdir: temp, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const testCase of [
    { name: 'live-prose', mode: 'live', text: plain, fontSize: 14 },
    { name: 'source-control', mode: 'source', text: plain, fontSize: 14 },
    { name: 'live-rich-large-font', mode: 'live', text: rich, fontSize: 32 },
    { name: 'live-table', mode: 'live', text: rich.split('\n').slice(30).join('\n'), fontSize: 14 }
  ] as const) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
      await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
      await page.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({postMessage(){},getState(){},setState(){}});' });
      await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
      await page.evaluate(({ mode, text, fontSize }) => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///native-scroll-progress.md', text, version: 1,
        savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'en',
        sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '',
        previewSourceColoring: true, editorAppearance: 'light', editorFontSizeMode: 'custom',
        editorFontSize: fontSize, gitChangesGutter: false, gitDiffLineHighlights: false,
        gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false,
        fixedBaselineActive: false, contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
        findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
        outlineVisible: false, outlineWidth: 260, vscodeTheme: null
      } })), testCase);
      await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content');
      await page.click('.editor-host > .cm-editor .cm-content .cm-line');
      await frames(page, 4);
      const bounds = await page.$eval('.editor-host > .cm-editor .cm-scroller', element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(bounds.x, bounds.y);
      // CDP's wheel default is an instantaneous scroll in our headless runtime.
      // Keep the trusted wheel, but exercise the browser's native animation at
      // the platform seam so several scroll frames can follow one wheel event.
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
        (window as any).__scrollWheels = [];
        scroller.addEventListener('wheel', event => {
          (window as any).__scrollWheels.push({ trusted: event.isTrusted, delta: event.deltaY });
          if (!(window as any).__animateScroll) return;
          event.preventDefault();
          scroller.scrollBy({ top: event.deltaY, behavior: 'smooth' });
        }, { capture: true, passive: false });
      });
      for (const animated of [false, true]) {
        await page.evaluate(animated => { (window as any).__animateScroll = animated; }, animated);
        for (const delta of [120, 120, 120, 120, -120, -120, -120, -120]) {
          const before = await page.$eval('.editor-host > .cm-editor .cm-scroller', element => element.scrollTop);
          // Hold one concrete document element as an independent visual witness.
          await page.evaluate(() => {
            const s = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
            const rect = s.getBoundingClientRect();
            const witness = [...s.querySelectorAll<HTMLElement>('.cm-content > .cm-line, table tbody tr')].find(line => {
              const r = line.getBoundingClientRect();
              return r.top >= rect.top + 160 && r.bottom <= rect.bottom - 160;
            });
            (window as any).__scrollWitness = witness;
            (window as any).__scrollWitnessTop = witness?.getBoundingClientRect().top;
          });
          await page.mouse.wheel({ deltaY: delta });
          await frames(page, 48);
          const after = await page.evaluate(() => {
            const s = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
            const witness = (window as any).__scrollWitness as HTMLElement | undefined;
            return {
              top: s.scrollTop,
              visualDelta: witness?.isConnected
                ? witness.getBoundingClientRect().top - (window as any).__scrollWitnessTop
                : null
            };
          });
          assert.ok(Math.abs(after.top - before - delta) <= 2,
            `${testCase.name} ${animated ? 'animated' : 'instant'} wheel was blocked: ${JSON.stringify({ before, delta, after })}`);
          assert.notEqual(after.visualDelta, null, 'Scroll test lost its visual witness');
          assert.ok(Math.abs(after.visualDelta! + delta) <= 2,
            `Visible content failed to follow the wheel: ${JSON.stringify({ testCase: testCase.name, delta, after })}`);
        }
      }
      const wheels = await page.evaluate(() => (window as any).__scrollWheels as Array<{ trusted: boolean }>);
      assert.equal(wheels.length, 16);
      assert.ok(wheels.every(wheel => wheel.trusted), 'Scroll regression must originate from trusted wheel input');
      if (testCase.name === 'live-table') {
        assert.ok(await page.$('table tbody tr'), 'Table wheel case must mount an actual rendered table');
      }
      console.log(`${testCase.name}: instant and multi-frame native scroll progress passed`);
    } finally { await page.close(); }
  }
} catch (error) { primaryError = error; }
finally {
  fs.rmSync(temp, { recursive: true, force: true });
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
