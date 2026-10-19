import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 640 });
  await page.setContent('<style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => {
    const api = (window as any).__liveHistory;
    const text = '# Source window\n\nEDIT\n\n```javascript\n' + 'const value = { number: 1, text: "sample" };\n'.repeat(9_000) + '```\n\nEND';
    const editor = (window as any).sourceWindowEditor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'source' });
    api.parse(editor);
    editor.view.dispatch({ selection: { anchor: text.indexOf('EDIT') + 4 } });
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  const sample = await page.evaluate(() => {
    const editor = (window as any).sourceWindowEditor, api = (window as any).__liveHistory;
    const prototype = Object.getPrototypeOf(editor.view.state.doc), original = prototype.line;
    const owned = Object.hasOwn(prototype, 'line');
    let lineReads = 0;
    prototype.line = function(...args: any[]) { lineReads++; return original.apply(this, args); };
    try {
      const start = performance.now();
      api.input(editor, editor.view.state.selection.main.head, 'x');
      return { lineReads, dispatch: performance.now() - start };
    } finally { if (owned) prototype.line = original; else delete prototype.line; }
  });
  assert.ok(sample.lineReads < 400, `Source input must not enumerate all 9,000 offscreen code rows: ${JSON.stringify(sample)}`);
  await page.evaluate(() => (window as any).sourceWindowEditor.scrollToLine(4500, 'center'));
  await page.waitForFunction(() => document.querySelectorAll('.cm-line.meo-src-code-block').length > 10);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.cm-line')].every(line => line.classList.contains('meo-src-code-block'))), 'newly mounted distant code rows must retain their styling');
  await page.evaluate(() => (window as any).sourceWindowEditor.destroy());
  console.log(`Source code presentation follows the actual viewport: ${JSON.stringify(sample)}`);
} finally { await closeTestBrowser(browser); }
