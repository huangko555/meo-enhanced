import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const dist = path.resolve(import.meta.dir, '../webview/dist');
const text = '# Pending mode\n\n' + Array.from({ length: 1_600 }, (_, index) =>
  `## Section ${index}\n\nA **formatted** paragraph.\n\n` +
  '```javascript\nconst item = { key: "value", count: 123 };\nconsole.log(item);\n```\n\n' +
  '```markdown\n# Literal heading\n\nLiteral **Markdown**.\n```\n\n').join('');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/') return new Response('<!doctype html><link rel="stylesheet" href="/index.css"><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark" data-meo-git-diff-worker-src="/git-diff-worker.js"><div id="app"></div><script type="module" src="/index.js"></script>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const file = path.resolve(dist, '.' + decodeURIComponent(pathname));
  return file.startsWith(dist + path.sep) && fs.existsSync(file)
    ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 });
}});
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
let primaryError: unknown;
let failed = false;
let stage = 'startup';
let activePage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
try {
  const page = await browser.newPage();
  activePage = page;
  page.setDefaultTimeout(15_000);
  await page.setViewport({ width: 1100, height: 720 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.exposeFunction('__modeHost', (message: any) => message.type === 'ready' ? {
    type: 'init', documentId: 'file:///mode-preparation.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
    sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
    findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
    outlineVisible: false, outlineWidth: 260, restoreReadingPositionOnOpen: false, vscodeTheme: null
  } : null);
  await page.evaluateOnNewDocument(() => {
    (window as any).acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: unknown) {
      (window as any).__modeHost(message).then((response: unknown) => {
        if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
      });
    }});
  });
  await page.goto(server.url.href);
  await page.waitForSelector('.editor-host > .cm-editor.meo-mode-source');
  await page.evaluate(() => {
    const scope = window as any;
    const view = (document.querySelector('.editor-host .cm-content') as any).cmView.view;
    const realNow = Date.now;
    let ticks = realNow();
    scope.__restoreModeClock = () => { Date.now = realNow; };
    Date.now = () => ticks += 100;
    // Replacing the document invalidates its complete parse even when its text
    // is identical. Force the actual production preparation to span frames.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: view.state.doc.toString() } });
    (document.querySelector('button[data-mode="live"]') as HTMLButtonElement).click();
    requestAnimationFrame(() => {
      scope.__modePreparationFrame = {
        sourceVisible: !!document.querySelector('.editor-host > .cm-editor.meo-mode-source'),
        busy: document.querySelector('button[data-mode="live"]')?.getAttribute('aria-busy'),
        cancellable: !(document.querySelector('button[data-mode="source"]') as HTMLButtonElement).disabled
      };
    });
  });
  await page.waitForFunction(() => !!(window as any).__modePreparationFrame);
  stage = 'pending frame';
  const pending = await page.evaluate(() => (window as any).__modePreparationFrame);
  assert.ok(pending.sourceVisible, 'the existing Source surface must paint during preparation');
  assert.equal(pending.busy, 'true', 'the requested Live control must expose preparation until the actual surface is ready');
  assert.ok(pending.cancellable, 'a mode preparation must allow a newer mode intent');
  if (process.env.MEO_TEST_SCREENSHOT) await page.screenshot({ path: process.env.MEO_TEST_SCREENSHOT });
  await page.evaluate(() => {
    (window as any).__restoreModeClock();
    (document.querySelector('button[data-mode="source"]') as HTMLButtonElement).click();
  });
  stage = 'cancel';
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('data-mode') === 'source'
    && !!document.querySelector('.editor-host > .cm-editor.meo-mode-source')
    && !document.querySelector('.mode-group [aria-busy="true"]'));
  await page.click('button[data-mode="live"]');
  stage = 'retry';
  await page.waitForFunction(() => !!document.querySelector('.editor-host > .cm-editor.meo-mode-live')
    && !document.querySelector('.mode-group [aria-busy="true"]'));
  const finalText = await page.$eval('.editor-host .cm-content', element => (element as any).cmView.view.state.doc.toString());
  assert.equal(finalText, text, 'cancellation and retry must retain the exact document');
  assert.deepEqual(errors, []);
  console.log('Production mode preparation, cancellation and real-surface readiness passed');
} catch (error) {
  failed = true;
  primaryError = error;
  console.error(stage, await activePage?.evaluate(() => ({
    mode: document.querySelector('#app')?.getAttribute('data-mode'),
    classes: document.querySelector('.editor-host > .cm-editor')?.className,
    busy: Array.from(document.querySelectorAll('.mode-group [aria-busy]')).map(element => element.outerHTML),
    notice: document.querySelector('.editor-notice')?.textContent
  })));
  throw error;
}
finally {
  try {
    if (failed) await closeTestBrowser(browser, primaryError);
    else await closeTestBrowser(browser);
  } finally { server.stop(true); }
}
