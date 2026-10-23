import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-outline-floating-dismissal-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const heading = { text: 'Heading', level: 1, from: 0, line: 1 };
let primaryError: unknown;
async function start(editorPresent = true) {
  await page.setViewport({ width: 700, height: 500 });
  await page.setContent('<!doctype html><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style><div id="root" class="editor-root"><div class="editor-wrapper"></div></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--meo-background:#1e1e1e;--meo-foreground:#ddd;--meo-semantic-mutedForeground:#aaa}body{background:#1e1e1e;color:#ddd}.outline-sidebar{height:100%}' });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(editorPresent => {
    const scope = window as any;
    const root = document.getElementById('root')!, wrapper = root.querySelector<HTMLElement>('.editor-wrapper')!;
    scope.__outlineState = { present: editorPresent, pending: true, headings: [], messages: [], lastLine: 0 };
    const state = scope.__outlineState;
    const editor = { getHeadings: () => state.headings, isOutlinePending: () => state.pending,
      getViewportAnchorOffset: () => 0, getVisibleDocumentRange: () => ({ from: 0, to: 10, fromLine: 1, toLine: 4 }),
      getScrollElement: () => wrapper, scrollToLine: (line: number) => { state.lastLine = line; } };
    const outline = scope.OutlineFloatingDismissalHarness.createOutlineController({ root, editorWrapper: wrapper,
      outlineButton: document.createElement('button'), getEditor: () => state.present ? editor : null });
    wrapper.append(outline.sidebar);
    scope.__outline = outline;
    outline.setUiLanguage('zh-CN');
    new MutationObserver(() => {
      const text = outline.sidebar.querySelector('.outline-empty')?.textContent;
      if (text) state.messages.push({ text, elapsed: performance.now() - state.started });
    }).observe(outline.sidebar, { childList: true, characterData: true, subtree: true });
    state.started = performance.now();
    outline.setVisible(true);
  }, editorPresent);
}
async function complete(headings = [heading]) {
  await page.evaluate(headings => {
    const scope = window as any;
    scope.__outlineState.headings = headings;
    scope.__outlineState.pending = false;
    scope.__outline.refresh();
  }, headings);
}
const loadingShown = () => page.evaluate(() => document.querySelector('.outline-empty')?.textContent === '正在生成目录…');
try {
  await start();
  // Settle well inside the quiet window and inspect all delivered mutations.
  await page.evaluate(heading => {
    const scope = window as any;
    setTimeout(() => { scope.__outlineState.pending = false; scope.__outlineState.headings = [heading]; scope.__outline.refresh(); }, 60);
  }, heading);
  await page.waitForSelector('.outline-item'); await wait(250);
  assert.deepEqual(await page.evaluate(() => (window as any).__outlineState.messages), [], 'Fast completion must never flash loading or No headings');

  await start();
  await page.evaluate(heading => {
    const scope = window as any;
    // Completion after the final pre-deadline poll must still stay quiet.
    setTimeout(() => { scope.__outlineState.pending = false; scope.__outlineState.headings = [heading]; }, 170);
  }, heading);
  await page.waitForSelector('.outline-item'); await wait(250);
  assert.deepEqual(await page.evaluate(() => (window as any).__outlineState.messages), [], 'A completed result must be checked before showing the delayed status');

  await start(false);
  assert.equal(await loadingShown(), false);
  await page.waitForFunction(() => document.querySelector('.outline-empty')?.textContent === '正在生成目录…');
  const elapsed = await page.evaluate(() => (window as any).__outlineState.messages[0].elapsed);
  assert.ok(elapsed >= 195 && elapsed < 1_000, `Loading threshold: ${elapsed}ms`);
  fs.mkdirSync('.local/outline-startup', { recursive: true });
  await page.screenshot({ path: '.local/outline-startup/loading.png' });
  await page.evaluate(() => { (window as any).__outlineState.present = true; });
  await complete();
  assert.equal(await loadingShown(), false);
  assert.equal(await page.$eval('.outline-content', e => e.getAttribute('aria-busy')), 'false');

  await page.evaluate(() => {
    const scope = window as any;
    scope.__outlineWitness = document.querySelector('.outline-item');
    scope.__outlineState.messages = [];
    scope.__outlineState.pending = true;
    scope.__outlineState.headings = [{ text: 'Heading', level: 1, from: 10, line: 3 }];
    scope.__outline.refresh();
  });
  await wait(300);
  assert.deepEqual(await page.evaluate(() => (window as any).__outlineState.messages), [], 'An accepted outline stays quiet during editing');
  await page.click('.outline-item');
  assert.equal(await page.evaluate(() => (window as any).__outlineState.lastLine), 3, 'Pending navigation uses mapped source lines');
  await complete([{ ...heading, from: 10, line: 3 }]);
  assert.equal(await page.evaluate(() => (window as any).__outlineWitness.isConnected), true, 'Unchanged rows survive pending and complete publication');

  await start(); await page.evaluate(() => (window as any).__outline.setVisible(false)); await wait(250);
  assert.equal(await loadingShown(), false, 'Hiding cancels the loading deadline');
  await page.evaluate(() => (window as any).__outline.setVisible(true));
  assert.equal(await loadingShown(), false, 'Reopening starts a new quiet window');
  await complete([]); await wait(250);
  assert.equal(await page.$eval('.outline-empty', e => e.textContent), '暂无标题', 'Only a complete empty outline may say No headings');
  assert.equal(await page.$eval('.outline-content', e => e.getAttribute('aria-busy')), 'false');
  assert.deepEqual(errors, []);
  console.log('Outline delayed loading, quiet refresh, cancellation and empty result passed');
} catch (error) { primaryError = error; }
finally { if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
