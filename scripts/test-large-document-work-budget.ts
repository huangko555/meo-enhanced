import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const dist = path.resolve(import.meta.dir, '../webview/dist');
assert.ok(fs.existsSync(path.join(dist, 'index.js')), 'Build the production Webview first');
const text = [
  '# Large document work budget', '', '$$', 'a+b', '$$', '',
  '| Near | Table |', '| --- | --- |', '| first | row |', '',
  ...Array.from({ length: 4_100 }, (_, index) => 'Synthetic paragraph ' + index + '.\n'),
  '## Distant rich content', '',
  '| Distant | Table |', '| --- | --- |', '| last | row |', '',
  ...Array.from({ length: 12 }, (_, index) => '$$\nx_' + index + '=1\n$$\n'),
  '```mermaid', 'flowchart LR', '  A[Budget] --> B[Visible]', '```', '',
  'DOCUMENT-END'
].join('\n');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/') return new Response('<!doctype html><link rel="stylesheet" href="/index.css"><link rel="stylesheet" href="/katex/katex-embedded.css"><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark" data-meo-mermaid-src="/mermaid.min.js" data-meo-katex-src="/katex/katex-embedded.css"><div id="app"></div><script type="module" src="/index.js"></script>', { headers: { 'Content-Type': 'text/html' } });
  const file = path.resolve(dist, '.' + decodeURIComponent(pathname));
  return file.startsWith(dist + path.sep) && fs.existsSync(file)
    ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 });
}});
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
let primaryError: unknown;
let stage = 'startup';
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  await page.setViewport({ width: 1100, height: 720 });
  const messages: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.exposeFunction('__budgetHost', (message: any) => {
    messages.push(message.type);
    if (message.type === 'ready') return {
      type: 'init', documentId: 'file:///large-document-budget.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
      sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
      outlineVisible: false, outlineWidth: 260, restoreReadingPositionOnOpen: false, vscodeTheme: null
    };
    if (message.type !== 'requestPreviewRender') return null;
    return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true,
      value: exportRuntime.renderPreviewDocument({ markdownText: message.text, sourceDocumentPath: 'C:/large-document-budget.md', uiLanguage: message.uiLanguage, styleEnvironment: message.environment }) } };
  });
  await page.evaluateOnNewDocument(() => {
    const activeMath = new Set<Element>();
    (window as any).__budgetActiveMath = activeMath;
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      private targets = new Set<Element>();
      observe(target: Element, options?: ResizeObserverOptions) {
        this.targets.add(target);
        if (target.matches('.meo-export-math-display, .meo-export-math-inline')) activeMath.add(target);
        super.observe(target, options);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        activeMath.delete(target);
        super.unobserve(target);
      }
      disconnect() {
        for (const target of this.targets) activeMath.delete(target);
        this.targets.clear();
        super.disconnect();
      }
    };
    (window as any).acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: unknown) {
      (window as any).__budgetHost(message).then((response: unknown) => {
        if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
      });
    }});
  });
  await page.goto(server.url.href);
  await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-editor.meo-mode-source');
  assert.equal(messages.includes('requestPreviewRender'), false, 'Source startup must leave the large hidden Preview unrendered');
  stage = 'source input';
  await page.focus('.editor-host .cm-content');
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type('-BUDGET-EDIT');
  await page.waitForFunction(() => document.querySelector('.editor-host .cm-content')?.textContent?.includes('DOCUMENT-END-BUDGET-EDIT'));
  stage = 'source undo';
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await page.waitForFunction(() => !document.querySelector('.editor-host .cm-content')?.textContent?.includes('BUDGET-EDIT'));
  stage = 'preview';
  await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true
    && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc'));
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-math-display.meo-latex-math-viewport'));
  stage = 'distant resource budget';
  const initial = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return { distantMath: Array.from(doc.querySelectorAll('.meo-export-math-display')).slice(1)
      .filter(element => element.classList.contains('meo-latex-math-viewport')).length,
      distantDiagrams: doc.querySelectorAll('.meo-export-mermaid.is-rendered').length,
      distantTable: !!doc.querySelectorAll('table')[1]?.querySelector('colgroup[data-meo-preview-columns]') };
  });
  assert.equal(initial.distantMath, 0, 'distant math must not allocate viewport controllers');
  assert.equal(initial.distantDiagrams, 0, 'distant diagrams must remain unrendered');
  assert.equal(initial.distantTable, false, 'distant tables must not force intrinsic layout');
  stage = 'viewport reveal';
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
    .querySelector('.meo-export-mermaid')!.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
    ?.querySelector('.meo-export-mermaid.is-rendered svg'));
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const distant = frame.contentDocument!.querySelectorAll('.meo-export-math-display')[1];
    return (frame.contentWindow as any).__budgetActiveMath.has(distant);
  });
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
    ?.querySelectorAll('table')[1]?.querySelector('colgroup[data-meo-preview-columns]'));
  stage = 'viewport retirement';
  await page.evaluate(() => { document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 0; });
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    return Array.from(frame.contentDocument!.querySelectorAll('.meo-export-math-display')).slice(1)
      .every(element => !(frame.contentWindow as any).__budgetActiveMath.has(element));
  });
  stage = 'preview hide and resume';
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.getElementById('app')?.dataset.mode === 'source');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const first = frame.contentDocument?.querySelector('.meo-export-math-display');
    return first && (frame.contentWindow as any).__budgetActiveMath.has(first);
  });
  assert.equal(await page.evaluate(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
    ?.querySelector('.meo-latex-math-canvas .meo-latex-math-canvas')), false, 'resuming formulas must not nest presentation wrappers');
  assert.deepEqual(errors, []);
  console.log('Large document work budget: Source input/undo, hidden Preview, viewport math/tables/diagrams and suspension/resume passed');
} catch (error) {
  console.error('Large document budget failed during ' + stage);
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
  server.stop(true);
}
