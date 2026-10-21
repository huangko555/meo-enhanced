import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { preparePreviewDocument } from '../src/export/runtime';

const source = Array.from({ length: 18_000 }, (_, index) => index === 0 ? 'const scope = {' : index === 17999 ? '};'
  : index === 8800 ? '/* comment starts before the reading band'
  : index === 9001 ? '*/' : `const row${index} = { text: "content", number: 123 };`).join('\n');
const payload = preparePreviewDocument({ markdownText: '```javascript\n' + source + '\n```',
  sourceDocumentPath: 'C:/giant-code.md', uiLanguage: 'en' }, true).renderAll();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-giant-code-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, `
  import * as highlight from ${JSON.stringify(path.resolve('webview/src/helpers/previewCodeHighlight.ts'))};
  import { activateShikiCodeHighlighting, setShikiTheme } from ${JSON.stringify(path.resolve('webview/src/helpers/shikiHighlighter.ts'))};
  (window as any).highlight = highlight;
  (window as any).release = activateShikiCodeHighlighting('preview');
  (window as any).theme = (color: string) => setShikiTheme({name: color, type: 'dark',
    tokenColors: [{scope: ['keyword', 'storage.type'], settings: {foreground: color}},
      {scope: 'comment', settings: {foreground: '#999999'}}]}, 'preview');
`);
const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 760 });
  await page.setContent(`<!doctype html><style>${payload.styles.dark}</style><main class="meo-export-doc">${payload.html}</main>`);
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => (window as any).theme('#55aa55'));
  await page.waitForFunction(() => (window as any).highlight.isPreviewCodeHighlightReady(document), { timeout: 30_000 });
  for (const stage of ['initial', 'cached', 'end', 'theme', 'middle', 'resize']) {
    if (stage === 'end') await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    if (stage === 'middle') await page.evaluate(() => document.querySelectorAll('.meo-export-code-line-source')[9000]!.scrollIntoView({ block: 'center' }));
    if (stage === 'resize') await page.setViewport({ width: 320, height: 760 });
    if (stage === 'theme') {
      await page.evaluate(() => (window as any).theme('#cc4444'));
      await page.waitForFunction(() => (window as any).highlight.isPreviewCodeHighlightReady(document), { timeout: 30_000 });
    }
    const result = await page.evaluate(() => {
      const sources = [...document.querySelectorAll<HTMLElement>('.meo-export-code-line-source')];
      const visible = sources.filter(line => { const rect = line.getBoundingClientRect(); return rect.bottom >= 0 && rect.top < innerHeight; });
      const observer = new MutationObserver(() => {}); observer.observe(document.querySelector('code')!, { childList: true, subtree: true });
      const started = performance.now();
      (window as any).highlight.applyPreviewCodeHighlight(document, true);
      const records = observer.takeRecords(); observer.disconnect();
      return { ms: performance.now() - started, writes: records.length, colored: sources.filter(line => line.dataset.meoShiki).length,
        visible: visible.length, visibleColored: visible.every(line => !!line.dataset.meoShiki && !!line.querySelector('span[style]')),
        colors: visible.flatMap(line => { const keyword = [...line.querySelectorAll('span')].find(span => span.textContent === 'const');
          return keyword ? [getComputedStyle(keyword).color] : []; }),
        commentColor: getComputedStyle(sources[9000]!.querySelector('span') ?? sources[9000]!).color,
        bracketColor: [...sources[9002]!.querySelectorAll('span')].find(span => span.textContent === '{')?.style.color,
        text: sources.map(line => line.textContent).join('\n') };
    });
    console.log(JSON.stringify({ stage, ms: result.ms, writes: result.writes, colored: result.colored, visible: result.visible }));
    if (stage === 'initial' && process.argv.includes('--capture')) {
      fs.mkdirSync('.local/input-presentation', { recursive: true });
      await page.screenshot({ path: '.local/input-presentation/giant-preview-code.png' });
    }
    assert.ok(result.writes < 240, 'A giant code block must project only the reading band, rather than rebuilding 18,000 rows');
    if (stage === 'cached') assert.equal(result.writes, 0, 'A settled reading band must retain its token DOM');
    assert.ok(result.visible > 0 && result.visibleColored, 'Every visible row must receive full-context syntax tokens');
    assert.ok(result.colors.every(color => color === (['initial', 'cached', 'end'].includes(stage) ? 'rgb(85, 170, 85)' : 'rgb(204, 68, 68)')));
    assert.equal(result.text, source, 'Viewport projection must retain the complete selectable/copyable code');
    if (stage === 'middle') assert.equal(result.commentColor, 'rgb(153, 153, 153)', 'A middle row must retain the preceding multi-line grammar context');
    if (stage === 'middle') assert.equal(result.bracketColor, 'rgb(218, 112, 214)', 'Visible brackets must retain nesting from offscreen preceding lines');
  }
  await page.evaluate(() => (window as any).release());
  console.log('Giant Preview code highlighting stays bounded across scrolling, theme changes and wrapping');
} catch (error) { primary = error; throw error; }
finally { fs.rmSync(temporary, { recursive: true, force: true });
  if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
