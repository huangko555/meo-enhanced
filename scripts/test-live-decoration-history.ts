import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-decoration-history-'));
const build = await Bun.build({ entrypoints: [path.join(root, 'scripts/test-live-decoration-history-entry.ts')],
  target: 'browser', format: 'iife', outdir: directory, naming: 'bundle.js' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent('<style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addScriptTag({ path: path.join(directory, 'bundle.js') });
  const original = 'EDIT\n\n' + 'Ordinary paragraph.\n\n'.repeat(4_100)
    + '## Distant heading\n\n**Distant bold**\n\n| Name | Value |\n| --- | --- |\n| item | 42 |\n\n$$x=1$$\n\n<div>HTML body</div>\n\nTAIL';
  await page.evaluate(text => {
    const api = (window as any).__liveHistory;
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    editor.setMode('source');
    editor.setMode('live');
    (window as any).__editor = editor;
  }, original);
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.evaluate(() => {
    const api = (window as any).__liveHistory;
    const editor = (window as any).__editor;
    editor.view.dispatch({ selection: { anchor: 4 } });
    (window as any).__before = api.decorations(editor);
    api.input(editor, 4, 'x');
    editor.setDiagnostics([]);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  const settled = await page.evaluate(() => {
    const scope = window as any;
    const current = scope.__liveHistory.decorations(scope.__editor);
    scope.__after = current;
    return { before: scope.__before.size, after: current.size, text: scope.__editor.getText() };
  });
  assert.equal(settled.text, original.slice(0, 4) + 'x' + original.slice(4));
  assert.equal(settled.after, settled.before, 'settling input must retain the authoritative offscreen presentation');
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
    assert.equal(await page.evaluate(() => (window as any).__editor.getText()), original);
    assert.equal(await page.evaluate(() => {
      const scope = window as any;
      return scope.__liveHistory.decorations(scope.__editor) === scope.__before;
    }), true, 'the real Editor history path must restore the complete checkpoint');
    assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
    assert.equal(await page.evaluate(() => {
      const scope = window as any;
      return scope.__liveHistory.decorations(scope.__editor) === scope.__after;
    }), true, 'redo must reuse the opposite complete checkpoint');
  }
  await page.evaluate(() => {
    const scope = window as any;
    scope.__liveHistory.input(scope.__editor, 5, 'y', Date.now() + 10_000);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    return scope.__liveHistory.decorations(scope.__editor) === scope.__after;
  }), true, 'a new native history group must capture its own complete presentation');
  assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.scrollToLine(editor.view.state.doc.lines, 'upper');
  });
  await page.waitForSelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea');
  await page.$eval('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea', input => {
    (input as HTMLTextAreaElement).focus();
    (input as HTMLTextAreaElement).value = 'changed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const editedTable = await page.evaluate(() => (window as any).__editor.getText());
  assert.ok(editedTable.includes('| changed | 42 |'), 'a restored distant table must edit its current source');
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  assert.equal(await page.evaluate(() => (window as any).__editor.getText()), original.slice(0, 4) + 'x' + original.slice(4));
  assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
  assert.equal(await page.evaluate(() => (window as any).__editor.getText()), editedTable);

  await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__editor;
    let diagnostic = { from: 1, to: 3, severity: 1, message: 'Example', source: 'test', code: 'example' };
    editor.setDiagnostics([diagnostic]);
    const first = editor.view.state;
    editor.setDiagnostics([{ ...diagnostic }]);
    if (first !== editor.view.state) throw Error('Identical diagnostics must not dispatch a transaction');
    for (const patch of [{ message: 'Changed' }, { severity: 2 }, { source: 'other' }, { code: 'other' }, { from: 0 }, { to: 4 }]) {
      diagnostic = { ...diagnostic, ...patch };
      const previous = editor.view.state;
      editor.setDiagnostics([diagnostic]);
      if (previous === editor.view.state) throw Error('Changed diagnostic data was ignored');
    }
    scope.__liveHistory.input(editor, 0, 'x');
    const mapped = editor.view.state;
    editor.setDiagnostics([diagnostic]);
    if (mapped === editor.view.state) throw Error('Moved diagnostics must accept current host positions');
    const actual = scope.__liveHistory.diagnostics(editor)[0];
    if (actual.from !== diagnostic.from || actual.to !== diagnostic.to) throw Error('Diagnostic positions were not restored');
    editor.setDiagnostics([]);
    const empty = editor.view.state;
    editor.setDiagnostics([]);
    if (empty !== editor.view.state) throw Error('Empty diagnostics must remain a no-op');
  });
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).__editor.destroy());
  console.log('Live settlement geometry and repeated production Editor undo/redo checkpoints passed');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
  fs.rmSync(directory, { recursive: true, force: true });
}
