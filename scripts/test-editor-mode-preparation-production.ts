import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const dist = path.resolve(import.meta.dir, '../webview/dist');
const text = '# Pending mode\n\n' + Array.from({ length: 1_600 }, (_, index) =>
  `## Section ${index}\n\nA **formatted** paragraph.\n\n` +
  '```javascript\nconst item = { key: "value", count: 123 };\nconsole.log(item);\n```\n\n' +
  '```markdown\n# Literal heading\n\nLiteral **Markdown**.\n```\n\n').join('');
const preparedModules = new Map<string, string>();
function withPreparationGate(file: string): string | undefined {
  if (!path.basename(file).startsWith('editor-') || !file.endsWith('.js')) return;
  const cached = preparedModules.get(file);
  if (cached) return cached;
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let preparation: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.body && node.name.getText(ast) === 'prepareLiveSyntax'
      && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) preparation = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!preparation?.body) return;
  const position = preparation.body.getStart(ast) + 1;
  // Pause only this async boundary, without perturbing the parser's budgets
  // or unrelated production timers through a replacement of Date.now.
  const result = source.slice(0, position)
    + 'if(globalThis.__modePreparationGate){globalThis.__modePreparationEntered=true;await globalThis.__modePreparationGate;}'
    + source.slice(position);
  preparedModules.set(file, result);
  return result;
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/') return new Response('<!doctype html><link rel="stylesheet" href="/index.css"><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark" data-meo-git-diff-worker-src="/git-diff-worker.js"><div id="app"></div><script type="module" src="/index.js"></script>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const file = path.resolve(dist, '.' + decodeURIComponent(pathname));
  if (file.startsWith(dist + path.sep) && fs.existsSync(file)) {
    const gated = withPreparationGate(file);
    if (gated) return new Response(gated, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
  }
  return file.startsWith(dist + path.sep) && fs.existsSync(file)
    ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 });
}});
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
let primaryError: unknown;
let failed = false;
let stage = 'startup';
let activePage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
const consoleErrors: string[] = [];
try {
  const page = await browser.newPage();
  activePage = page;
  page.setDefaultTimeout(15_000);
  await page.setViewport({ width: 1100, height: 720 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', async message => {
    if (message.type() !== 'error') return;
    const parts = await Promise.all(message.args().map(argument => argument.evaluate(value =>
      value instanceof Error ? value.stack : String(value)).catch(() => '<unavailable>')));
    consoleErrors.push(parts.join(' '));
  });
  let initialMode: 'live' | 'source' = 'source';
  await page.exposeFunction('__modeHost', (message: any) => message.type === 'ready' ? {
    type: 'init', documentId: 'file:///mode-preparation.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: initialMode, uiLanguage: 'en',
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
  // Mounting the editor precedes the initial presentation reveal. Do not start
  // cancellation while the real toolbar is still an aria-hidden preload shell.
  await page.waitForFunction(() => !document.querySelector('.meo-preload-toolbar')
    && !document.querySelector('.meo-preload-editor-shell'));
  await page.evaluate(() => {
    const scope = window as any;
    scope.__modeTestClicks = [];
    document.addEventListener('click', event => {
      const button = (event.target as Element)?.closest('button');
      scope.__modeTestClicks.push({ mode: button?.dataset.mode, label: button?.textContent, trusted: event.isTrusted });
    }, true);
  });
  await page.evaluate(() => {
    const scope = window as any;
    scope.__modePreparationGate = new Promise<void>(resolve => { scope.__releaseModePreparation = resolve; });
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
    const scope = window as any;
    delete scope.__modePreparationGate;
    (document.querySelector('button[data-mode="source"]') as HTMLButtonElement).click();
    scope.__releaseModePreparation();
  });
  stage = 'cancel';
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('data-mode') === 'source'
    && !!document.querySelector('.editor-host > .cm-editor.meo-mode-source')
    && !document.querySelector('.mode-group [aria-busy="true"]'));
  // Source presentation can still rearrange toolbar groups in the next frame.
  // Use Puppeteer's stable-bounds locator before issuing the real mouse click.
  await page.locator('button[data-mode="live"]').click();
  assert.ok(await page.evaluate(() => (window as any).__modeTestClicks.some((event: any) => event.trusted && event.mode === 'live')),
    'the retry mouse click must reach Live itself');
  stage = 'retry';
  await page.waitForFunction(() => !!document.querySelector('.editor-host > .cm-editor.meo-mode-live')
    && !document.querySelector('.mode-group [aria-busy="true"]'));
  const finalText = await page.$eval('.editor-host .cm-content', element => (element as any).cmTile.root.view.state.doc.toString());
  assert.equal(finalText, text, 'cancellation and retry must retain the exact document');
  stage = 'cold Live cancellation';
  initialMode = 'live';
  await page.evaluateOnNewDocument(() => {
    const scope = window as any;
    scope.__modePreparationGate = new Promise<void>(resolve => { scope.__releaseModePreparation = resolve; });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__modePreparationEntered === true
    && !!document.querySelector('.editor-host > .cm-editor'));
  await page.evaluate(() => {
    const scope = window as any, wrapper = document.querySelector('.editor-wrapper')!;
    const inspect = () => {
      const host = document.querySelector<HTMLElement>('.editor-host')!;
      if (wrapper.classList.contains('meo-preload-editor-shell') || host.inert
        || document.querySelector<HTMLElement>('.editor-loading')?.hidden === false) return;
      scope.__coldReveal = { requested: document.querySelector('#app')?.getAttribute('data-mode'),
        actual: document.querySelector('.editor-host > .cm-editor')?.classList.contains('meo-mode-source') };
      observer.disconnect();
    };
    const observer = new MutationObserver(inspect);
    observer.observe(wrapper, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden', 'inert', 'aria-busy'] });
    (document.querySelector('button[data-mode="source"]') as HTMLButtonElement).click();
    scope.__releaseModePreparation();
  });
  await page.waitForFunction(() => !!(window as any).__coldReveal);
  assert.deepEqual(await page.evaluate(() => (window as any).__coldReveal), { requested: 'source', actual: true },
    'a newer mode intent during cold preparation must reveal that actual surface');
  assert.equal(await page.$eval('.editor-host .cm-content', element => (element as any).cmTile.root.view.state.doc.toString()), text);
  assert.deepEqual(errors, []);
  console.log('Production mode preparation, cancellation and real-surface readiness passed');
} catch (error) {
  failed = true;
  primaryError = error;
  console.error(stage, consoleErrors, await activePage?.evaluate(() => ({
    mode: document.querySelector('#app')?.getAttribute('data-mode'),
    classes: document.querySelector('.editor-host > .cm-editor')?.className,
    busy: Array.from(document.querySelectorAll('.mode-group [aria-busy]')).map(element => element.outerHTML),
    clicks: (window as any).__modeTestClicks,
    notice: Array.from(document.querySelectorAll('[class*="notice"]')).map(element => [element.className, element.textContent])
  })));
  throw error;
}
finally {
  try {
    if (failed) await closeTestBrowser(browser, primaryError);
    else await closeTestBrowser(browser);
  } finally { server.stop(true); }
}
