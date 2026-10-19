import assert from 'node:assert/strict';
import exportRuntime from '../src/export/runtime';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import fs from 'node:fs';
import path from 'node:path';

const formulas = '# Formula viewport\n\nInline $a+b$ stays in prose.\n\n$$\n\\frac{x^2+1}{y}=\\sqrt{z}\n$$\n\n';
const text = formulas + Array.from({ length: 4_100 }, (_, index) => `Paragraph ${index}.\n\n`).join('')
  + '## Distant formulas\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n```latex\n\\text{中文} + \\frac{1}{2}\n```\n\nEND';
const value = exportRuntime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: 'C:/formula-viewport.md', uiLanguage: 'en' });
assert.equal((value.html.match(/data-meo-deferred-math=/g) ?? []).length, 3,
  'large Preview must send source for offscreen display formulas instead of expanding every formula');
assert.ok(value.html.includes('katex'), 'inline formulas retain their original prose layout');
const small = exportRuntime.renderPreviewDocument({ markdownText: formulas, sourceDocumentPath: 'C:/small.md', uiLanguage: 'en' });
assert.ok(small.html.includes('katex-display'));
assert.ok(!small.html.includes('data-meo-deferred-math'));
const exported = renderMarkdownToHtml({ markdownText: text, markdownFilePath: 'C:/formula-viewport.md', target: 'html' });
assert.ok(exported.html.includes('katex-display'), 'exports remain complete standalone documents');
assert.ok(!exported.html.includes('data-meo-deferred-math'));
console.log('Large Preview defers display formulas; inline, small documents and exports stay complete');

const build = await Bun.build({ entrypoints: ['scripts/test-preview-code-update-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const dist = path.resolve(import.meta.dir, '../webview/dist');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/') return new Response('<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0}body{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;background:#1e1e1e}</style><body class="vscode-dark" data-meo-katex-src="/katex/katex-embedded.css"></body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const file = path.resolve(dist, '.' + decodeURIComponent(pathname));
  return file.startsWith(dist + path.sep) && fs.existsSync(file) ? new Response(Bun.file(file)) : new Response('missing', { status: 404 });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
let failure: unknown;
let stage = 'render';
let diagnosticPage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
try {
  const page = await browser.newPage();
  diagnosticPage = page;
  page.setDefaultTimeout(8_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1100, height: 720 });
  await page.goto(server.url.href);
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.evaluate(() => { document.body.style.backgroundColor = '#1e1e1e'; });
  await page.addStyleTag({ content: '.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const render = async (text: string, value: unknown, preserve = false) => {
    await page.evaluate(({ text, value, preserve }) => {
      const scope = window as any, controller = scope.__previewController;
      scope.__previewRenderedAt = 0;
      controller.setVisible(true);
      controller.setSourceColoring(false);
      void controller.requestRender(text, { force: true, preserveViewport: preserve, preserveFrame: preserve });
      const message = scope.__previewMessages.filter((m: any) => m.type === 'requestPreviewRender').at(-1);
      controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
    }, { text, value, preserve });
    await page.waitForFunction(() => !!(window as any).__previewRenderedAt);
  };
  await render(text, value);
  stage = 'first formula and copy';
  await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const first = doc.querySelector('.meo-export-math-display');
    return first?.querySelector('.katex-display') && first.querySelector(':scope > .meo-preview-code-actions [role="button"]');
  });
  const first = await page.evaluate(() => {
    const scope = window as any, doc = scope.__previewController.host.querySelector('iframe').contentDocument;
    const roots = [...doc.querySelectorAll('.meo-export-math-display')];
    scope.__firstFormula = roots[0];
    scope.__firstFormulaHtml = roots[0].querySelector('.katex-display');
    const decode = (source: string) => new TextDecoder().decode(Uint8Array.from(atob(source), character => character.charCodeAt(0)));
    return {
      rendered: roots.filter((root: Element) => root.querySelector('.katex-display')).length,
      pending: roots.filter((root: Element) => root.hasAttribute('data-meo-deferred-math')).length,
      copy: decode(roots[0].getAttribute('data-source-b64')),
      inline: doc.querySelector('.meo-export-math-inline')?.textContent,
      copyButton: !!roots[0].querySelector(':scope > .meo-preview-code-actions [role="button"]')
    };
  });
  assert.equal(first.rendered, 1, 'only the nearby display formula is expanded');
  assert.equal(first.pending, 2, 'distant formulas retain their source and cheap DOM');
  assert.equal(first.copy, '\\frac{x^2+1}{y}=\\sqrt{z}');
  assert.equal(first.inline, 'a+b', 'inline prose remains immediately rendered');
  assert.ok(first.copyButton, 'hydration preserves direct copy controls');

  const updatedText = 'A new introductory paragraph.\n\n' + text;
  stage = 'preserved formula update';
  await render(updatedText, exportRuntime.renderPreviewDocument({ markdownText: updatedText, sourceDocumentPath: 'C:/formula-viewport.md', uiLanguage: 'en' }), true);
  assert.equal(await page.evaluate(() => {
    const scope = window as any, doc = scope.__previewController.host.querySelector('iframe').contentDocument;
    return doc.contains(scope.__firstFormula) && doc.contains(scope.__firstFormulaHtml)
      && !scope.__firstFormula.hasAttribute('data-meo-deferred-math')
      && Number(scope.__firstFormula.dataset.sourceLine) === 7;
  }), true, 'unchanged formula DOM survives a source-map update without reverting to a placeholder');

  stage = 'hidden and revealed formulas';
  await page.evaluate(() => {
    const scope = window as any, controller = scope.__previewController;
    controller.setVisible(false);
    const doc = controller.host.querySelector('iframe').contentDocument;
    doc.scrollingElement.scrollTop = doc.scrollingElement.scrollHeight;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    return doc.querySelectorAll('[data-meo-deferred-math]').length;
  }), 2, 'hidden Preview does not generate distant formulas');
  await page.evaluate(() => {
    const controller = (window as any).__previewController;
    controller.setVisible(true);
    const doc = controller.host.querySelector('iframe').contentDocument;
    controller.getOutlineAdapter().scrollToLine(Number([...doc.querySelectorAll('.meo-export-math-display')].at(-1).dataset.sourceLine));
  });
  await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    return doc.querySelectorAll('.meo-export-math-display .katex-display').length === 3;
  });
  const visible = await page.evaluate(async () => {
    const controller = (window as any).__previewController, doc = controller.host.querySelector('iframe').contentDocument;
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    const last = [...doc.querySelectorAll('.meo-export-math-display')].at(-1) as HTMLElement;
    const rect = last.getBoundingClientRect();
    return { text: last.textContent, visible: rect.bottom > 0 && rect.top < doc.documentElement.clientHeight,
      firstRetained: doc.contains((window as any).__firstFormulaHtml), height: rect.height };
  });
  assert.ok(visible.text.includes('中文') && visible.visible && visible.height > 0, 'UTF-8 formula source renders on reveal at its reading position');
  assert.ok(visible.firstRetained, 'offscreen formula retains its generated DOM');
  stage = 'atomic visible formula update';
  await page.evaluate(() => {
    const scope = window as any;
    scope.__previewRenderProbe = () => {
      const doc = scope.__previewController.host.querySelector('iframe').contentDocument;
      const last = [...doc.querySelectorAll('.meo-export-math-display')].at(-1);
      scope.__formulaCommit = !!last?.querySelector('.katex-display') && !last.hasAttribute('data-meo-deferred-math');
      scope.__previewRenderProbe = undefined;
    };
  });
  const changedText = updatedText.replace('\\frac{1}{2}', '\\frac{3}{4}');
  await render(changedText, exportRuntime.renderPreviewDocument({ markdownText: changedText, sourceDocumentPath: 'C:/formula-viewport.md', uiLanguage: 'en' }), true);
  assert.equal(await page.evaluate(() => (window as any).__formulaCommit), true,
    'updating an already generated formula must commit its result without a raw-TeX frame');
  if (process.env.MEO_TEST_SCREENSHOT) await page.screenshot({ path: process.env.MEO_TEST_SCREENSHOT });
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).__previewController.dispose());
  console.log('Deferred Preview formulas: visible-only work, exact copy, preserved DOM, hidden/reveal and reading position passed');
} catch (error) { failure = error; console.error(stage, await diagnosticPage?.evaluate(() => {
  const scope = window as any, doc = scope.__previewController?.host.querySelector('iframe')?.contentDocument;
  return { formulas: [...(doc?.querySelectorAll('.meo-export-math-display') ?? [])].map((element: Element) => element.outerHTML.slice(0, 350)), copyControls: doc?.querySelectorAll('.meo-preview-code-actions').length };
})); throw error; }
finally {
  try {
    if (failure === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, failure);
  } finally { server.stop(true); }
}
