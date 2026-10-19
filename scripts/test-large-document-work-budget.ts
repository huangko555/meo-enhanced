import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';

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
  if (pathname === '/') return new Response('<!doctype html><link rel="stylesheet" href="/index.css"><link rel="stylesheet" href="/katex/katex-embedded.css"><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark" data-meo-mermaid-src="/mermaid.min.js" data-meo-katex-src="/katex/katex-embedded.css" data-meo-git-diff-worker-src="/git-diff-worker.js" data-meo-shiki-worker-src="/shiki-highlight-worker.js"><div id="app"></div><script type="module" src="/index.js"></script>', { headers: { 'Content-Type': 'text/html' } });
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
  const previewTexts: string[] = [];
  const previewDocuments = new Map<string, ReturnType<typeof createPreviewDocument>>();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.exposeFunction('__budgetHost', async (message: any) => {
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
    if (message.type === 'requestPreviewDocument') {
      const document = previewDocuments.get(message.documentId);
      assert.ok(document, 'Preview must reference an accepted parser context');
      return { type: 'previewDocumentResult', documentId: message.documentId, requestId: message.requestId,
        result: { ok: true, value: await document.run(message.operation) } };
    }
    if (message.type !== 'requestPreviewRender') return null;
    previewTexts.push(message.text);
    const options = { markdownText: message.text, sourceDocumentPath: 'C:/large-document-budget.md', uiLanguage: message.uiLanguage,
      styleEnvironment: message.environment };
    const document = message.window ? createPreviewDocument(message.requestId, options) : null;
    if (document) previewDocuments.set(message.requestId, document);
    return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true,
      value: document ? document.open(message.window.anchorLine) : exportRuntime.renderPreviewDocument(options) } };
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
  await page.evaluate(() => {
    const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
    scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
  });
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
    ?.querySelector('.meo-export-mermaid.is-rendered svg'));
  stage = 'distant formula initialization';
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    return [...frame.contentDocument!.querySelectorAll('.meo-export-math-display')]
      .some(element => (frame.contentWindow as any).__budgetActiveMath.has(element));
  });
  stage = 'distant table layout';
  for (let step = 0; step < 8; step += 1) {
    const found = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const table = [...doc.querySelectorAll('table')].find(element => element.textContent?.includes('Distant'));
      if (table) { table.scrollIntoView({ block: 'center' }); return true; }
      doc.scrollingElement!.scrollTop -= 400;
      return false;
    });
    if (found) break;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
    ?.querySelector('table colgroup[data-meo-preview-columns]'));
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
  stage = 'editing and immediate three-mode round trips';
  let tail = 'DOCUMENT-END';
  for (const mode of ['source', 'live'] as const) {
    stage = `round trip ${mode}: activate`;
    await page.click(`button[data-mode="${mode}"]`);
    await page.waitForFunction(mode => document.getElementById('app')?.dataset.mode === mode
      && !!document.querySelector(`.editor-host:not([hidden]):not([inert]):not([data-preview-cover]) .cm-editor.meo-mode-${mode}`), {}, mode);
    await page.focus('.editor-host .cm-content');
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    const suffix = mode === 'source' ? 'SOURCE' : 'LIVE';
    await page.keyboard.type(suffix);
    tail += suffix;
    const client = await page.createCDPSession();
    await client.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await client.send('Input.insertText', { text: '中文' });
    await client.detach();
    tail += '中文';
    stage = `round trip ${mode}: accept input ${tail}`;
    await page.waitForFunction(tail => document.querySelector('.editor-host .cm-content')?.textContent?.includes(tail), {}, tail);
    // No quiet-window wait: clicking Preview must flush the latest accepted text.
    await page.click('button[data-mode="preview"]');
    stage = `round trip ${mode}: latest Preview`;
    await page.waitForFunction(tail => document.getElementById('app')?.dataset.mode === 'preview'
      && document.querySelector<HTMLElement>('.preview-status')?.hidden === true
      && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes(tail), {}, tail);
    assert.equal(previewTexts.at(-1), text + tail.slice('DOCUMENT-END'.length), 'Preview must render the exact unsaved editing revision');
    await page.click(`button[data-mode="${mode}"]`);
    stage = `round trip ${mode}: restore reading position`;
    await page.waitForFunction(({ mode, tail }) => {
      if (document.getElementById('app')?.dataset.mode !== mode) return false;
      const scroller = document.querySelector('.editor-host .cm-scroller')?.getBoundingClientRect();
      const line = Array.from(document.querySelectorAll('.editor-host .cm-line')).find(line => line.textContent?.includes(tail));
      const rect = line?.getBoundingClientRect();
      return rect && scroller && rect.top < scroller.bottom && rect.bottom > scroller.top;
    }, {}, { mode, tail });
  }
  assert.deepEqual(errors, []);
  console.log('Large document work budget: Source input/undo, hidden Preview, viewport resources, unsaved three-mode round trips and reading-position restoration passed');
} catch (error) {
  console.error('Large document budget failed during ' + stage);
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
  server.stop(true);
}
