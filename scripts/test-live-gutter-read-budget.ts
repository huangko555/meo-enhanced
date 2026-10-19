import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { installGitDiffWorker } from './git-diff-worker-fixture';

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 640 });
  await page.setContent('<style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await installGitDiffWorker(page);
  await page.evaluate(async () => {
    const api = (window as any).__liveHistory;
    const text = Array.from({ length: 12_000 }, (_, index) => `Paragraph ${index} ordinary words to edit.\n\n`).join('');
    const editor = (window as any).gutterBudgetEditor = api.create({ parent: document.getElementById('editor'), text,
      initialMode: 'source', initialGitGutter: true });
    api.parse(editor);
    editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit', baseText: text });
    await editor.setMode('live');
  });
  await page.waitForFunction(() => (window as any).__liveHistory.gitSummary((window as any).gutterBudgetEditor).status === 'ready');
  const reads = await page.evaluate(() => {
    const view = (window as any).gutterBudgetEditor.view;
    const prototype = Object.getPrototypeOf(view.state.doc), line = prototype.line;
    const own = Object.hasOwn(prototype, 'line');
    let reads = 0;
    prototype.line = function(...args: any[]) { reads++; return line.apply(this, args); };
    try {
      view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 3 } });
      view.dispatch({ selection: { anchor: view.state.doc.line(9).from + 3 } });
      return reads;
    } finally { if (own) prototype.line = line; else delete prototype.line; }
  });
  assert.ok(reads < 500, `Live caret must not read all 24,000 Git gutter rows: ${reads}`);
  await page.evaluate(() => (window as any).gutterBudgetEditor.destroy());
  console.log(`Live caret with a ready Git baseline reads ${reads} source rows`);
} finally { await closeTestBrowser(browser); }
