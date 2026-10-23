import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import type { DocumentViewState } from '../src/foundation/documentViewState';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-save-as-view-'));
const text = [
  ...Array.from({ length: 100 }, (_, n) => `Before reading line ${n + 1}`), '',
  '| Row | Wrapped content |', '| --- | --- |',
  ...Array.from({ length: 40 }, (_, n) => `| ${n + 1} | ${'wrapped content '.repeat(15)}<br>second line |`), '',
  ...Array.from({ length: 300 }, (_, n) => `After reading line ${n + 1}`)
].join('\n');
const build = await Bun.build({ entrypoints: ['scripts/test-long-document-scroll-entry.ts'],
  outdir: temp, naming: 'bundle.js', target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
async function frames(page: Page, count: number) {
  await page.evaluate(async count => { for (let n = 0; n < count; n++) await new Promise(requestAnimationFrame); }, count);
}
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const mode of ['live', 'source'] as const) for (const memoryEnabled of [true, false]) {
    const init = { type: 'init', documentId: 'file:///original.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'en',
      sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'light', editorFontSizeMode: 'custom', editorFontSize: 16,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
      fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
      restoreReadingPositionOnOpen: memoryEnabled, readingPositionRestore: null,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null };
    const createPage = async (data: Record<string, unknown>) => {
      const page = await browser.newPage();
      if (process.argv.includes('--slow-renderer')) await page.emulateCPUThrottling(4);
      await page.setViewport({ width: 900, height: 650 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.addScriptTag({ content: 'window.__messages=[];window.acquireVsCodeApi=()=>({postMessage(m){window.__messages.push(m)},getState(){},setState(){}});' });
      await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
      await page.evaluate(data => {
        const inspect = () => {
          const editor = document.querySelector('.editor-wrapper:not(.meo-preload-editor-shell) .editor-host > .cm-editor');
          const host = document.querySelector<HTMLElement>('.editor-host');
          const loading = document.querySelector<HTMLElement>('.editor-loading');
          // The delayed loading fallback reveals its shell before its covered
          // editor. Only an exposed reading surface is a first visible frame.
          if (editor && !host?.inert && loading?.hidden !== false) {
            const { EditorView, getViewportController } = (window as any).LongDocumentScrollHarness;
            const view = EditorView.findFromDOM(editor);
            const anchor = getViewportController(view).captureDocumentAnchor();
            (window as any).__firstVisible = { line: view.state.doc.lineAt(anchor.position).number, lineOffset: anchor.lineOffset };
          } else requestAnimationFrame(inspect);
        };
        requestAnimationFrame(inspect);
        window.dispatchEvent(new MessageEvent('message', { data }));
      }, data);
      await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content');
      return page;
    };
    const original = await createPage(init);
    await original.evaluate(() => {
      const { EditorView, getViewportController } = (window as any).LongDocumentScrollHarness;
      const view = EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      const controller = getViewportController(view);
      controller.restoreDocumentAnchor({ position: view.state.doc.line(340).from, lineOffset: 13 });
      view.dispatch({ selection: { anchor: 24, head: 40 } });
    });
    await frames(original, 20);
    await original.click('[data-action="saveAs"]');
    await original.waitForFunction(() => (window as any).__messages.some((m: any) => m.type === 'saveDocumentAs'));
    const request = await original.evaluate(() => (window as any).__messages.find((m: any) => m.type === 'saveDocumentAs'));
    const state = request.viewState as DocumentViewState;
    assert.ok(state.position.line > 300, 'Save As must capture the current view rather than the caret near the document start');
    assert.deepEqual(state.selection, { anchor: 24, head: 40 });
    const destination = await createPage({ ...init, documentId: 'file:///new.md', saveAsViewState: state });
    await frames(destination, 30);
    const result = await destination.evaluate(() => {
      const { EditorView, getViewportController } = (window as any).LongDocumentScrollHarness;
      const view = EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      const anchor = getViewportController(view).captureDocumentAnchor();
      return { first: (window as any).__firstVisible, line: view.state.doc.lineAt(anchor.position).number,
        lineOffset: anchor.lineOffset, anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
    });
    assert.equal(result.first.line, state.position.line, 'the first visible frame must already show the saved position');
    assert.ok(Math.abs(result.first.lineOffset - state.position.lineOffset) <= 2);
    assert.equal(result.line, state.position.line, 'late table layout must not reset the destination viewport');
    assert.ok(Math.abs(result.lineOffset - state.position.lineOffset) <= 2);
    assert.deepEqual({ anchor: result.anchor, head: result.head }, state.selection);
    console.log(`${mode}, opening memory ${memoryEnabled}: Save As snapshot, first visible frame and settled position passed`);
    await original.close(); await destination.close();
  }
} catch (error) { primaryError = error; }
finally {
  fs.rmSync(temp, { recursive: true, force: true });
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
