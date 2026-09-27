import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-table-layout-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, `
  import { createPreviewTableLayoutController } from ${JSON.stringify(path.resolve(import.meta.dir, '../webview/src/helpers/previewTableLayout.ts'))};
  (window as any).startTables = () => {
    (window as any).tableController = createPreviewTableLayoutController(document);
  };
`);
const markdown = Array.from({ length: 80 }, (_, index) => (
  `| Metric ${index} | Description | Value |\n|---|---|---|\n| row-${index} | A_long_word_with_中文_and_emoji_😀_that_must_wrap | ${index} |`
)).join('\n\n');
const payload = exportRuntime.renderPreviewDocument({
  markdownText: markdown, sourceDocumentPath: 'C:/table-layout.md', uiLanguage: 'en'
});

try {
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    for (const width of [280, 640, 1100]) {
      for (const theme of ['light', 'dark'] as const) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 720, deviceScaleFactor: 1.5 });
        await page.setContent(`<!doctype html><style>${payload.styles[theme]}</style><main class="meo-export-doc">${payload.html}</main>`);
        await page.addScriptTag({ content: await build.outputs[0].text() });
        const client = await page.createCDPSession();
        await client.send('Performance.enable');
        for (const stage of ['initial', 'cached', 'content', 'font', 'resize']) {
          if (stage === 'resize') await page.setViewport({ width: width + 95, height: 720, deviceScaleFactor: 1.5 });
          const before = (await client.send('Performance.getMetrics')).metrics;
          await page.evaluate(stage => {
            if (stage === 'initial') (window as any).startTables();
            else {
              if (stage === 'content') document.querySelector('td')!.textContent = 'Changed longer content '.repeat(8);
              if (stage === 'font') document.querySelector<HTMLElement>('main')!.style.fontSize = '22px';
              (window as any).tableController.refresh();
            }
            void document.body.offsetHeight;
          }, stage);
          const after = (await client.send('Performance.getMetrics')).metrics;
          const layouts = after.find(item => item.name === 'LayoutCount')!.value
            - before.find(item => item.name === 'LayoutCount')!.value;
          // Enforce bounded layout work without a machine-dependent time budget.
          // The former per-table read/write loop incurred 320 layouts here.
          assert.ok(layouts <= 16, JSON.stringify({ width, theme, stage, layouts }));
          const geometry = await page.evaluate(() => Array.from(
            document.querySelectorAll<HTMLTableElement>('.meo-table-scroll > table')
          ).map(table => {
            const wrapper = table.parentElement!;
            return {
              rightOverhang: table.getBoundingClientRect().right
                - (wrapper.getBoundingClientRect().left + wrapper.clientLeft + wrapper.clientWidth),
              cellWidths: Array.from(table.rows[0].cells).map(cell => cell.getBoundingClientRect().width)
            };
          }));
          assert.equal(geometry.length, 80);
          assert.ok(geometry.every(table => table.rightOverhang <= 0.1
            && table.cellWidths.every(value => value > 0)), JSON.stringify({ width, theme, stage, geometry }));
        }
        await page.evaluate(() => (window as any).tableController.dispose());
        await page.close();
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
  console.log('Preview table batched layout checks passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}