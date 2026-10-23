import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import exportRuntime from '../src/export/runtime';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const dist = path.resolve(import.meta.dir, '../webview/dist');
const text = '# Editable view\n\nA paragraph that remains editable after loading.\n';
const prepared = new Map<string, string>();
let moduleGate: Promise<void> | null = null;
let moduleHeld = false;
function gatedIndex(file: string): string {
  const cached = prepared.get(file);
  if (cached) return cached;
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let method: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'applyEditorMode') method = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(method?.body, 'The production mode adapter must retain its asynchronous apply boundary');
  const preparation = method.body.statements.find(ts.isTryStatement);
  assert.ok(preparation, 'Hold preparation after the production intent/currentness guard has been captured');
  const mode = method.parameters[0]!.name.getText(ast), position = preparation.tryBlock.getStart(ast) + 1;
  const result = source.slice(0, position)
    + `const testGate=globalThis.__editorModeGate;if(testGate?.mode===${mode}){globalThis.__editorModeEntered=${mode};await testGate.wait;if(testGate.fail)throw Error('Controlled mode preparation failure');}`
    + source.slice(position);
  prepared.set(file, result);
  return result;
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  if (pathname === '/') return new Response('<!doctype html><link rel="stylesheet" href="/index.css"><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark" data-meo-markdown-worker-src="/markdown-parse-worker.js" data-meo-git-diff-worker-src="/git-diff-worker.js" data-meo-shiki-worker-src="/shiki-highlight-worker.js"><div id="app"></div><script type="module" src="/index.js"></script>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const file = path.resolve(dist, '.' + pathname);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) return new Response('Missing', { status: 404 });
  if (/^editor-[^/]+\.js$/.test(path.basename(file)) && moduleGate) { moduleHeld = true; await moduleGate; }
  return path.basename(file) === 'index.js'
    ? new Response(gatedIndex(file), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
    : new Response(Bun.file(file), { headers: file.endsWith('.js') ? { 'Content-Type': 'text/javascript' } : {} });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync('.local/editor-loading', { recursive: true });
let primaryError: unknown;
async function open(mode: 'live' | 'source') {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.setViewport({ width: 1100, height: 720 });
  await page.setCacheEnabled(false);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.exposeFunction('__editorLoadingHost', (message: any) => {
    if (message.type === 'ready') return { type: 'init', documentId: 'file:///loading.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'zh-CN', sourceLineNumbers: 'on',
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14, previewAppearance: 'dark',
      previewFontFamily: '', previewSourceColoring: false, gitChangesGutter: false, gitDiffLineHighlights: false,
      gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true, findOptions: { wholeWord: false, caseSensitive: false },
      outlineVisible: false, outlinePosition: 'right', outlineWidth: 260, restoreReadingPositionOnOpen: false, vscodeTheme: null };
    if (message.type === 'requestPreviewRender') return { type: 'previewRenderResult', requestId: message.requestId,
      result: { ok: true, value: exportRuntime.renderPreviewDocument({ markdownText: message.text, sourceDocumentPath: 'C:/fixtures/loading.md',
        uiLanguage: 'zh-CN', styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth }) } };
    return null;
  });
  await page.evaluateOnNewDocument(() => {
    const scope = window as any;
    scope.__loadingShows = [];
    let shown = false;
    new MutationObserver(() => {
      const loading = document.querySelector<HTMLElement>('.editor-loading');
      const next = !!loading && !loading.hidden;
      if (next && !shown) scope.__loadingShows.push({ elapsed: performance.now() - scope.__loadingStart, text: loading!.textContent });
      shown = next;
    }).observe(document, { childList: true, attributes: true, subtree: true });
    scope.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: unknown) {
      scope.__editorLoadingHost(message).then((data: any) => {
        if (!data) return;
        if (data.type === 'init') scope.__loadingStart = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data }));
      });
    } });
  });
  await page.goto(server.url.href, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}
type Page = Awaited<ReturnType<typeof browser.newPage>>;
async function settled(page: Page, mode: 'live' | 'source') {
  await page.waitForFunction(mode => document.querySelector<HTMLElement>('#app')?.dataset.mode === mode
    && !!document.querySelector(`.editor-host > .cm-editor.meo-mode-${mode}`)
    && document.querySelector<HTMLElement>('.editor-loading')?.hidden
    && !document.querySelector<HTMLElement>('.editor-host')?.inert && !document.querySelector('.meo-preload-editor-shell'), {}, mode).catch(async error => {
      console.error('Unsettled editor', mode, await page.evaluate(() => ({
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        editor: document.querySelector('.editor-host > .cm-editor')?.className,
        loadingHidden: document.querySelector<HTMLElement>('.editor-loading')?.hidden,
        inert: document.querySelector<HTMLElement>('.editor-host')?.inert,
        preload: !!document.querySelector('.meo-preload-editor-shell'),
        notice: document.querySelector('.editor-notice')?.textContent,
        entered: (window as any).__editorModeEntered
      })));
      throw error;
    });
}
async function show(page: Page, mode: 'live' | 'source') {
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-loading')!.hidden, { timeout: 2_000 });
  const state = await page.evaluate(() => ({ show: (window as any).__loadingShows.at(-1),
    opacity: getComputedStyle(document.querySelector('.editor-wrapper')!).opacity,
    inert: document.querySelector<HTMLElement>('.editor-host')!.inert,
    underline: getComputedStyle(document.querySelector('.mode-button.is-active .segmented-control-button-indicator')!, '::after').content }));
  assert.ok(state.show.elapsed >= 195 && state.show.elapsed < 1_500, JSON.stringify(state));
  assert.equal(state.show.text, mode === 'live' ? '正在加载实时视图…' : '正在加载源码视图…');
  assert.equal(state.opacity, '1', 'The bootstrap cover must not hide loading feedback');
  assert.equal(state.inert, true, 'An unfinished editor must not accept input behind the loading surface');
  assert.ok(state.underline === 'none' || state.underline === 'normal', 'No mode preparation underline');
}
async function hold(page: Page, mode: 'live' | 'source', fail = false) {
  await page.evaluate(({ mode, fail }) => {
    const scope = window as any;
    scope.__editorModeEntered = null;
    const gate: any = { mode, fail };
    gate.wait = new Promise(resolve => { gate.release = resolve; });
    scope.__editorModeGate = gate;
    scope.__loadingShows = []; scope.__loadingStart = performance.now();
    document.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)!.click();
  }, { mode, fail });
  await page.waitForFunction(mode => (window as any).__editorModeEntered === mode, {}, mode);
}
async function release(page: Page) {
  await page.evaluate(() => { const scope = window as any; scope.__editorModeGate?.release(); delete scope.__editorModeGate; });
}
try {
  for (const mode of ['source', 'live'] as const) {
    let releaseModule!: () => void;
    moduleHeld = false; moduleGate = new Promise(resolve => { releaseModule = resolve; });
    const { page, errors } = await open(mode);
    try {
      await show(page, mode); assert.equal(moduleHeld, true, 'The actual cold editor module must still be pending');
      await page.screenshot({ path: `.local/editor-loading/cold-${mode}.png` });
      moduleGate = null; releaseModule(); await settled(page, mode);
      console.log(`Cold ${mode} loading passed`);
      assert.deepEqual(errors, []);
    } finally { moduleGate = null; releaseModule(); await page.close(); }
  }
  const { page, errors } = await open('source');
  try {
    await settled(page, 'source');
    await hold(page, 'live'); await show(page, 'live');
    await page.screenshot({ path: '.local/editor-loading/live-transition.png' });
    await page.keyboard.type('999');
    await page.click('[data-mode="source"]'); await settled(page, 'source');
    await release(page); await wait(250); await settled(page, 'source');
    assert.equal(await page.$eval('.editor-host .cm-content', e => (e as any).cmTile.root.view.state.doc.toString()), text,
      'Keyboard input must not edit the covered, unfinished editor');
    await page.click('[data-mode="live"]'); await settled(page, 'live');
    await hold(page, 'source'); await show(page, 'source'); await release(page); await settled(page, 'source');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.editor-host')), true,
      'A loading cover must restore editor focus lost to inert when the user has not focused another control');

    // An already prepared switch and ordinary editing never show progress.
    await page.evaluate(() => { (window as any).__loadingShows = []; });
    await page.click('[data-mode="live"]'); await settled(page, 'live'); await wait(250);
    assert.deepEqual(await page.evaluate(() => (window as any).__loadingShows), []);
    await page.click('.editor-host .cm-line'); await page.keyboard.press('End'); await page.keyboard.type('123'); await wait(300);
    assert.deepEqual(await page.evaluate(() => (window as any).__loadingShows), [], 'Typing must never start a view loading status');

    await hold(page, 'source', true); await show(page, 'source'); await release(page); await settled(page, 'live');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-notice')?.hidden === false);

    // A full Preview is still the cover before the atomic split commit. Do not
    // expose only its right-hand fragments beside a half-width loading surface.
    await page.click('[data-mode="source"]'); await settled(page, 'source');
    await page.click('.source-preview-button');
    await page.waitForFunction(() => document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1')
      && document.querySelector<HTMLElement>('.preview-loading')?.hidden);
    const previewReady = () => page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview'
      && document.querySelector<HTMLElement>('.editor-loading')?.hidden
      && document.querySelector<HTMLElement>('.preview-loading')?.hidden
      && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1'));
    await page.click('[data-mode="preview"]'); await previewReady();
    await hold(page, 'source'); await show(page, 'source');
    const widths = await page.evaluate(() => ({ loading: document.querySelector('.editor-loading')!.getBoundingClientRect().width,
      editor: document.querySelector('.editor-host')!.getBoundingClientRect().width,
      surface: document.querySelector('.editor-surface')!.getBoundingClientRect().width }));
    assert.ok(Math.abs(widths.loading - widths.surface) < 1 && widths.editor < widths.surface * 0.6, JSON.stringify(widths));
    await page.screenshot({ path: '.local/editor-loading/source-split-transition.png' });
    await release(page); await settled(page, 'source');
    await hold(page, 'live'); await show(page, 'live');
    await page.click('[data-mode="preview"]'); await previewReady(); await release(page); await wait(250); await previewReady();
    assert.deepEqual(errors, []);
    console.log('Live/Source delayed loading: cold module, switching, cancellation, fast completion, quiet input, failure and split Preview passed');
  } finally { await release(page); await page.close(); }
} catch (error) { primaryError = error; }
finally { server.stop(true); if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
