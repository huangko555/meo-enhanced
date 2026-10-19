import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { installGitDiffWorker } from './git-diff-worker-fixture';

const root = path.resolve(import.meta.dir, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-background-diff-'));
const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-live-decoration-history-entry.ts')],
  target: 'browser', format: 'iife', outdir: directory, naming: 'bundle.js',
  plugins: [{ name: 'observe-main-thread-comparison', setup(builder) {
    builder.onLoad({ filter: /webview[\\/]src[\\/]liveMode\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'return buildDecorations(state, fallback, extra.changes);';
      assert.equal(source.split(boundary).length, 2);
      return { loader: 'ts', contents: source.replace(boundary,
        '(globalThis as any).__fullLiveBuilds = ((globalThis as any).__fullLiveBuilds ?? 0) + 1; ' + boundary) };
    });
    builder.onLoad({ filter: /src[\\/]shared[\\/]gitDiffCore\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = '  const { baseLines, currentLines } = splitComparableDocumentLines(baseText, currentText);';
      assert.equal(source.split(boundary).length, 2);
      return { loader: 'ts', contents: source.replace(boundary,
        '  (globalThis as any).__mainDiffComputations = ((globalThis as any).__mainDiffComputations ?? 0) + 1;\n' + boundary) };
    });
  } }]
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setContent('<style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addScriptTag({ path: path.join(directory, 'bundle.js') });
  await installGitDiffWorker(page, 150);
  await page.evaluate(() => {
    const scope = window as any, NativeWorker = window.Worker;
    scope.__workerCreates = 0; scope.__workerStops = 0; scope.__workerRequests = 0;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); scope.__workerCreates++; }
      postMessage(message: any) { scope.__workerRequests++; super.postMessage(message); }
      terminate() { scope.__workerStops++; super.terminate(); }
    };
  });
  const initial = await page.evaluate(() => {
    const scope = window as any;
    const text = 'EDIT\n\n| Name | Value |\n| --- | --- |\n| item | 1 |\n\n' + '**Formatted paragraph**.\n\n'.repeat(4_100)
      + '| Distant | Value |\n| --- | --- |\n| distant-item | 2 |\n';
    const editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text,
      initialMode: 'source', initialGitGutter: true, onApplyChanges() {} });
    scope.__editor = editor;
    scope.__mainDiffComputations = 0;
    editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit', baseText: text });
    return { large: scope.__liveHistory.largeBudget(editor), comparisons: scope.__mainDiffComputations };
  });
  assert.ok(initial.large, 'the regression must exercise the real large-document editor');
  assert.equal(initial.comparisons, 0, 'large-document baseline changes must not run document comparison on the UI thread');
  const ready = () => page.waitForFunction(() => (window as any).__liveHistory.gitSummary((window as any).__editor).status === 'ready');
  const summary = () => page.evaluate(() => (window as any).__liveHistory.gitSummary((window as any).__editor));
  await ready();
  assert.deepEqual(await summary(), { status: 'ready', added: 0, deleted: 0 });
  const input = await page.evaluate(() => {
    const scope = window as any;
    scope.__liveHistory.input(scope.__editor, 4, 'x');
    return { text: scope.__editor.getText().startsWith('EDITx'), summary: scope.__liveHistory.gitSummary(scope.__editor) };
  });
  assert.ok(input.text);
  assert.equal(input.summary.status, 'pending', 'changed content must immediately retire the previous ready summary');
  await ready();
  assert.deepEqual(await summary(), { status: 'ready', added: 1, deleted: 1 });
  assert.equal(await page.evaluate(() => document.querySelectorAll('.meo-git-gutter-marker.is-modified').length > 0), true,
    'Source gutter must consume the asynchronous result');
  const beforeSwitch = await page.evaluate(() => (window as any).__workerRequests);
  await page.evaluate(() => (window as any).__editor.setMode('live'));
  await ready();
  assert.equal(await page.evaluate(() => (window as any).__workerRequests), beforeSwitch,
    'mode changes must reuse a result for the same document and baseline');
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    editor.setGitBaseline({ available: true, tracked: true, baseText: editor.getText().replace('distant-item', 'old-item') });
    scope.__buildsBeforeResult = scope.__fullLiveBuilds;
  });
  await ready();
  assert.equal(await page.evaluate(() => (window as any).__fullLiveBuilds - (window as any).__buildsBeforeResult), 0,
    'a comparison result must not trigger a full Live Markdown rebuild');
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    const line = editor.view.state.doc.lineAt(editor.getText().indexOf('distant-item')).number;
    scope.__distantLine = line;
    editor.scrollToLine(line, 'center');
  });
  await page.waitForFunction(() => {
    const scope = window as any;
    return !!document.querySelector(`.meo-md-html-table-diff-marker.is-modified[data-meo-live-block-start-line="${scope.__distantLine}"]`);
  });
  assert.ok(await page.evaluate(() => document.querySelector('.meo-md-html-table')?.textContent?.includes('distant-item')),
    'a newly mounted offscreen table must display its real content and accepted diff markers');
  await page.evaluate(() => (window as any).__editor.scrollToLine(1, 'start'));
  // Replace a baseline while its earlier result is in flight, then type, undo,
  // and switch modes. No obsolete completion may restore the previous summary.
  await page.evaluate(() => {
    const scope = window as any;
    scope.__editor.setGitBaseline({ available: true, tracked: true, baseText: scope.__editor.getText() });
    scope.__requestsBeforeRace = scope.__workerRequests;
  });
  await page.waitForFunction(() => (window as any).__workerRequests > (window as any).__requestsBeforeRace);
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    editor.setGitBaseline({ available: true, tracked: true, baseText: editor.getText().replace('EDITx', 'ORIGINAL') });
    scope.__liveHistory.input(editor, 5, 'y', Date.now() + 10_000);
    editor.setMode('source');
  });
  await ready();
  assert.deepEqual(await summary(), { status: 'ready', added: 1, deleted: 1 });
  assert.ok(await page.evaluate(() => (window as any).__workerStops > 0), 'superseded running work must be terminated');
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  await ready();
  assert.ok(await page.evaluate(() => (window as any).__editor.getText().startsWith('EDITx\n')));
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    editor.setGitBaseline({ available: true, tracked: true, baseText: editor.getText() });
    scope.__liveHistory.beginComposition(editor);
    scope.__liveHistory.input(editor, 5, '中文');
  });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
  assert.equal((await summary()).status, 'pending', 'composition must not publish a ready result for stale content');
  await page.evaluate(() => {
    const scope = window as any; scope.__liveHistory.completeComposition(scope.__editor);
  });
  await ready();
  assert.deepEqual(await summary(), { status: 'ready', added: 1, deleted: 1 });
  assert.equal(await page.evaluate(() => (window as any).__mainDiffComputations), 0,
    'baseline, input, undo, composition and mode changes must never compare a large document on the UI thread');
  await page.evaluate(() => (window as any).__editor.destroy());
  await page.evaluate(() => {
    const scope = window as any;
    scope.__deleteFixtureRow = () => {
      const cell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="0"]')!;
      const rect = cell.getBoundingClientRect(), table = cell.closest('table')!;
      cell.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 41,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
      table.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 41,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
      document.querySelector<HTMLButtonElement>('button[data-tooltip="Delete row"]')!.click();
    };
    const text = '| Name |\n| --- |\n| one |\n| two |\n| three |\n\n' + 'Distant paragraph.\n\n'.repeat(5_000);
    scope.__editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text,
      initialMode: 'live', initialGitGutter: true, onApplyChanges() {}, onGitDiffSummaryChange(summary: any) {
        if (summary.status !== 'ready' || !scope.__deleteUponReady) return;
        scope.__deleteUponReady = false;
        queueMicrotask(() => {
          const editor = scope.__editor;
          scope.__liveHistory.input(editor, editor.getText().length - 2, 'x', Date.now() + 20_000);
          scope.__deleteFixtureRow(); scope.__autoDeleted = true;
        });
      } });
    scope.__editor.setGitBaseline({ available: true, tracked: true, baseText: 'Old prefix\n\n' + text });
  });
  await ready();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    editor.setGitBaseline({ available: true, tracked: true, baseText: editor.getText() });
    scope.__deleteFixtureRow();
    if (editor.getText().includes('| two |')) throw Error('The actual row command must remove its selected source row');
  });
  await ready();
  const originalRows = await page.evaluate(() => {
    const scope = window as any;
    return scope.__liveHistory.originalBlocks(scope.__editor).flatMap((block: any) => block.lines);
  });
  assert.deepEqual(originalRows, [{ number: 4, text: '| two |' }],
    'a row command while a new baseline is pending must never persist mappings from the previous baseline');
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  await ready();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const finalLine = await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    const baseline = 'New prefix\n\n' + editor.getText();
    scope.__deleteUponReady = true;
    editor.setGitBaseline({ available: true, tracked: true, baseText: baseline });
    return baseline.trimEnd().split('\n').length;
  });
  await page.waitForFunction(() => {
    const scope = window as any;
    return scope.__autoDeleted && scope.__liveHistory.gitSummary(scope.__editor).status === 'ready';
  });
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any;
    return scope.__liveHistory.originalBlocks(scope.__editor).flatMap((block: any) => block.lines);
  }), [{ number: 1, text: 'New prefix' }, { number: 2, text: '' },
    { number: 6, text: '| two |' }, { number: finalLine, text: 'Distant paragraph.' }],
  'back-to-back input and row removal after publication must not borrow a mounted widget\'s older baseline');
  await page.evaluate(() => (window as any).__editor.destroy());
  // A worker failure is explicit, with no expensive synchronous fallback.
  await page.evaluate(() => {
    document.body.dataset.meoGitDiffWorkerSrc = 'data:text/javascript,throw new Error("fixture worker failure")';
    const scope = window as any;
    const text = 'Plain paragraph.\n\n'.repeat(6_000);
    scope.__editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text,
      initialMode: 'source', initialGitGutter: true, onApplyChanges() {} });
    scope.__editor.setGitBaseline({ available: true, tracked: true, baseText: text });
  });
  await page.waitForFunction(() => (window as any).__liveHistory.gitSummary((window as any).__editor).status === 'unavailable');
  assert.deepEqual(await summary(), { status: 'unavailable', reason: 'error', added: 0, deleted: 0 });
  assert.equal(await page.evaluate(() => (window as any).__mainDiffComputations), 0);
  await installGitDiffWorker(page);
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    editor.setGitBaseline({ available: true, tracked: true, baseText: editor.getText() });
  });
  await ready();
  assert.deepEqual(await summary(), { status: 'ready', added: 0, deleted: 0 }, 'a new baseline may retry after a failed worker');
  await page.evaluate(() => (window as any).__editor.destroy());
  const ordinary = await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text: 'small\n',
      initialMode: 'source', initialGitGutter: true, onApplyChanges() {} });
    const creates = scope.__workerCreates;
    editor.setGitBaseline({ available: true, tracked: true, baseText: 'before\n' });
    const summary = scope.__liveHistory.gitSummary(editor);
    editor.destroy();
    return { summary, creates: scope.__workerCreates - creates, comparisons: scope.__mainDiffComputations };
  });
  assert.equal(ordinary.summary.status, 'ready', 'small documents must keep immediate summaries');
  assert.equal(ordinary.creates, 0, 'small documents must not create a worker');
  assert.equal(ordinary.comparisons, 1);
  const growth = await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text: 'small\n',
      initialMode: 'source', initialGitGutter: true, onApplyChanges() {} });
    scope.__editor = editor;
    editor.setGitBaseline({ available: true, tracked: true, baseText: 'small\n' });
    scope.__mainDiffComputations = 0;
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length,
      insert: 'Growing paragraph.\n\n'.repeat(5_000) }, userEvent: 'input.paste' });
    return { comparisons: scope.__mainDiffComputations, summary: scope.__liveHistory.gitSummary(editor) };
  });
  assert.equal(growth.comparisons, 0,
    'pasting a large document into an ordinary editor must not synchronously compare it before adaptive assessment');
  assert.equal(growth.summary.status, 'pending');
  await page.evaluate(() => (window as any).__editor.destroy());
  await installGitDiffWorker(page, 0, 100);
  await page.evaluate(() => {
    const scope = window as any, text = 'CHANGED\n\n' + 'Large paragraph.\n\n'.repeat(5_000);
    scope.__editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text,
      initialMode: 'source', initialGitGutter: true, onApplyChanges() {} });
    scope.__editor.setGitBaseline({ available: true, tracked: true, baseText: text.replace('CHANGED', 'ORIGINAL') });
  });
  await page.waitForFunction(() => (window as any).__liveHistory.gitSummary((window as any).__editor).status !== 'pending');
  assert.deepEqual(await summary(), { status: 'ready', added: 1, deleted: 1 },
    'background comparison must tolerate line preparation beyond the foreground 50ms budget');
  await page.evaluate(() => (window as any).__editor.destroy());
  await installGitDiffWorker(page, 0, 2_000);
  await page.evaluate(() => {
    const scope = window as any, text = 'CHANGED\n\n' + 'Large paragraph.\n\n'.repeat(5_000);
    scope.__editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text,
      initialMode: 'source', initialGitGutter: true, onApplyChanges() {} });
    scope.__editor.setGitBaseline({ available: true, tracked: true, baseText: text.replace('CHANGED', 'ORIGINAL') });
  });
  await page.waitForFunction(() => (window as any).__liveHistory.gitSummary((window as any).__editor).status !== 'pending');
  assert.deepEqual(await summary(), { status: 'unavailable', reason: 'timeout', added: 0, deleted: 0 },
    'background comparison must still enforce a finite computation budget');
  await page.evaluate(() => (window as any).__editor.destroy());
  assert.deepEqual(errors, []);
  console.log('Background diff editor contracts passed: real worker, pending/current ownership, cancellation, undo, IME, mode reuse, failure and small-document behavior.');
} catch (error) { primaryError = error; throw error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
  fs.rmSync(directory, { recursive: true, force: true });
}
