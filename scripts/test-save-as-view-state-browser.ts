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
  outdir: temp, naming: 'bundle.js', target: 'browser', format: 'iife',
  plugins: [{ name: 'save-as-destination-presentation-barrier', setup(builder) {
    builder.onLoad({ filter: /webview[\\/]src[\\/]index\.ts$/ }, async ({ path: file }) => {
      const source = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
      const anchor = '            await editor?.whenVisiblePresentationReady(LIVE_PRESENTATION_REVEAL_WAIT_MS);';
      assert.equal(source.split(anchor).length, 2);
      return { loader: 'ts', contents: source.replace(anchor,
        '            if ((globalThis as any).__saveAsPresentationGate) await (globalThis as any).__saveAsPresentationGate;\n' + anchor) };
    });
  } }] });
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
    const createPage = async (data: Record<string, unknown>, holdPresentation = false) => {
      const page = await browser.newPage();
      if (process.argv.includes('--slow-renderer')) await page.emulateCPUThrottling(4);
      await page.setViewport({ width: 900, height: 650 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.evaluate(({ text, hold }) => {
        const scope = window as any;
        scope.__messages = []; scope.__hostText = text; scope.__hostVersion = 1;
        if (hold) scope.__saveAsPresentationGate = new Promise(resolve => { scope.__releaseSaveAsPresentation = resolve; });
        scope.acquireVsCodeApi = () => ({ postMessage(message: any) {
          scope.__messages.push(message);
          if (message.type === 'applyChanges') {
            if (message.baseVersion !== scope.__hostVersion) throw Error('Unexpected fixture Host version');
            for (const change of [...message.changes].sort((a, b) => b.from - a.from))
              scope.__hostText = scope.__hostText.slice(0, change.from) + change.insert + scope.__hostText.slice(change.to);
            const version = ++scope.__hostVersion;
            queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'applied', version } })));
          }
        }, getState() {}, setState() {} });
      }, { text: data.text, hold: holdPresentation });
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
      if (holdPresentation) await page.evaluate(() => {
        if (!document.querySelector<HTMLElement>('.editor-host')?.inert) throw Error('Expected actual covered Source presentation');
        setTimeout(() => (window as any).__releaseSaveAsPresentation(), 80);
      });
      await page.waitForFunction(() => {
        const host = document.querySelector<HTMLElement>('.editor-host');
        return host?.hidden === false && !host.inert && !host.hasAttribute('aria-busy')
          && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false;
      });
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
    if (mode === 'source' && !memoryEnabled) {
      const baseline = '# Save As input\n\nBefore paragraph.\n\nAfter paragraph. SAVE_AS_SOURCE';
      const pending = await createPage({ ...init, text: baseline, documentId: 'file:///pending-copy.md',
        savedRevision: { version: 1, text: baseline }, saveAsViewState: { mode: 'source', position: { line: 5, lineOffset: 0 },
          selection: { anchor: baseline.length, head: baseline.length } } }, true);
      await pending.click('.editor-host .cm-content .cm-line:last-child');
      await pending.keyboard.down('Control'); await pending.keyboard.press('End'); await pending.keyboard.up('Control');
      await pending.keyboard.type(' FOCUS_CHANGE', { delay: 10 });
      await frames(pending, 4);
      const input = await pending.evaluate(() => {
        const scope = window as any;
        const view = scope.LongDocumentScrollHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        return { host: scope.__hostText, text: view.state.doc.toString() };
      });
      assert.equal(input.text, baseline + ' FOCUS_CHANGE', 'The first input after Save As must reach the accepted Source');
      assert.equal(input.host, input.text, 'The first input must reach the protocol Host exactly');
      await pending.close();
    }
  }
} catch (error) { primaryError = error; }
finally {
  fs.rmSync(temp, { recursive: true, force: true });
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
