import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-code-layout-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, `
  import { applyPreviewCodeHighlight, isPreviewCodeHighlightReady } from ${JSON.stringify(path.resolve(import.meta.dir, '../webview/src/helpers/previewCodeHighlight.ts'))};
  import { activateShikiCodeHighlighting, setShikiTheme } from ${JSON.stringify(path.resolve(import.meta.dir, '../webview/src/helpers/shikiHighlighter.ts'))};
  const release = activateShikiCodeHighlighting('preview');
  (window as any).highlight = { applyPreviewCodeHighlight, isPreviewCodeHighlightReady, setShikiTheme, release };
`);
const markdown = Array.from({ length: 60 }, (_, index) => [
  '```typescript',
  `const item${index} = "中文 and a long string that wraps in a narrow reading surface ${index}";`,
  index % 3 === 0 ? 'console.log("a second line");' : '',
  '```'
].filter(Boolean).join('\n')).join('\n\n');
const payload = exportRuntime.renderPreviewDocument({
  markdownText: markdown, sourceDocumentPath: 'C:/preview-code-layout.md', uiLanguage: 'en'
});

try {
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    for (const width of [280, 640, 1100]) {
      for (const appearance of ['light', 'dark'] as const) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 720, deviceScaleFactor: 1.5 });
        await page.setContent(`<!doctype html><style>${payload.styles[appearance]}</style><main class="meo-export-doc">${payload.html}</main>`);
        await page.addScriptTag({ content: await build.outputs[0].text() });
        const originalText = await page.$$eval('.meo-export-code-line-source', lines => lines.map(line => line.textContent));
        const client = await page.createCDPSession();
        await client.send('Performance.enable');
        for (const stage of ['initial', 'cached', 'theme', 'scroll', 'resize', 'all']) {
          if (stage === 'initial' || stage === 'theme') {
            await page.evaluate(({ appearance, changed }) => {
              (window as any).highlight.setShikiTheme({
                name: `layout-${appearance}-${changed}`, type: appearance,
                colors: { 'editor.foreground': appearance === 'dark' ? '#eeeeee' : '#222222' },
                tokenColors: [{ scope: ['keyword', 'storage.type'], settings: {
                  foreground: changed ? '#cc4444' : '#55aa55', fontStyle: changed ? 'bold italic' : ''
                } }]
              }, 'preview');
            }, { appearance, changed: stage === 'theme' });
            await page.waitForFunction(() => (window as any).highlight.isPreviewCodeHighlightReady(document));
          }
          if (stage === 'scroll') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          if (stage === 'resize') await page.setViewport({ width: width + 95, height: 720, deviceScaleFactor: 1.5 });
          // Flush pre-existing layout so the budget measures the actual projection work.
          await page.evaluate(() => { void document.documentElement.offsetHeight; });
          const before = (await client.send('Performance.getMetrics')).metrics;
          const observation = await page.evaluate(stage => {
            const nearOnly = stage !== 'all';
            const codes = Array.from(document.querySelectorAll<HTMLElement>('code.hljs'));
            const height = document.documentElement.clientHeight;
            const candidates = codes.filter(code => {
              const bounds = code.getBoundingClientRect();
              return !nearOnly || (bounds.bottom >= -height && bounds.top <= height * 2);
            });
            const started = performance.now();
            (window as any).highlight.applyPreviewCodeHighlight(document, nearOnly);
            void document.documentElement.offsetHeight;
            const durationMs = performance.now() - started;
            return {
              durationMs, candidates: candidates.length,
              projected: candidates.every(code => Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-source'))
                .every(line => !!line.dataset.meoShiki && !!line.querySelector('span[style]'))),
              visibleColored: codes.filter(code => {
                const bounds = code.getBoundingClientRect();
                return bounds.bottom >= 0 && bounds.top <= height;
              }).every(code => Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-source'))
                .every(line => line.dataset.meoShiki === candidates[0]?.querySelector<HTMLElement>('.meo-export-code-line-source')?.dataset.meoShiki)),
              totalColored: codes.filter(code => !!code.querySelector('[data-meo-shiki]')).length,
              keywordColors: candidates.map(code => Array.from(code.querySelectorAll<HTMLElement>('span[style]'))
                .find(span => span.textContent?.trim() === 'const')).map(span => span ? getComputedStyle(span).color : null),
              text: Array.from(document.querySelectorAll('.meo-export-code-line-source')).map(line => line.textContent)
            };
          }, stage);
          const after = (await client.send('Performance.getMetrics')).metrics;
          const layouts = after.find(item => item.name === 'LayoutCount')!.value
            - before.find(item => item.name === 'LayoutCount')!.value;
          console.log(JSON.stringify({ width, appearance, stage, layouts, durationMs: observation.durationMs, candidates: observation.candidates }));
          assert.ok(observation.candidates > 0 && observation.projected && observation.visibleColored, `Missing projected code: ${JSON.stringify({ width, appearance, stage, observation })}`);
          assert.deepEqual(observation.text, originalText, 'Highlighting must preserve all source text');
          assert.ok(observation.keywordColors.every(color => color === (['initial', 'cached'].includes(stage) ? 'rgb(85, 170, 85)' : 'rgb(204, 68, 68)')), `Theme colors differ: ${JSON.stringify(observation.keywordColors)}`);
          if (stage === 'initial') assert.ok(observation.totalColored < 60, 'Far code blocks must remain deferred');
          if (stage === 'all') assert.equal(observation.totalColored, 60);
          // Count layout passes instead of imposing a machine-dependent timing threshold.
          assert.ok(layouts <= 2, `Preview code projection caused repeated layout: ${JSON.stringify({ width, appearance, stage, layouts })}`);
        }
        await page.evaluate(() => (window as any).highlight.release());
        await page.close();
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
  console.log('Preview code highlight layout checks passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}