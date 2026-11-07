import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const windowed of [false, true]) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1200, height: 760 });
    const text = Array.from({ length: windowed ? 4_200 : 60 }, (_, i) =>
      `${i % 100 === 0 ? `## Section ${i}\n\n` : ''}Paragraph ${i} with **bold** and a long reading line.\n`).join('\n');
    assert.equal(assessLargeDocument(text).windowedPreview, windowed);
    const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
    let sequence = 0;
    let windowRequests = 0;
    await page.exposeFunction('__transitionHost', async (message: any) => {
      if (message.type === 'requestPreviewDocument') return {
        type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
        result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) }
      };
      if (message.type !== 'requestPreviewRender') return null;
      const options = { markdownText: message.text, sourceDocumentPath: 'C:/tmp/source-preview-transition.md',
        uiLanguage: message.uiLanguage, styleEnvironment: message.environment, layout: message.layout };
      let value;
      if (message.window) {
        windowRequests++;
        const documentId = `transition-${++sequence}`;
        const parsed = createPreviewDocument(documentId, options);
        documents.set(documentId, parsed);
        value = parsed.open(message.window.anchorLine);
      } else value = exportRuntime.renderPreviewDocument(options);
      return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } };
    });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: ':root{--vscode-editor-background:#252526;--vscode-editor-foreground:#ddd;--vscode-editor-font-size:14px;--vscode-editor-font-family:monospace}' });
    await page.addScriptTag({ content: `window.__transitionState={sourcePreviewScrollSyncEnabled:false};window.acquireVsCodeApi=()=>({getState(){return window.__transitionState},setState(state){window.__transitionState=state},postMessage(message){
      const held=window.__holdFullTransition&&message.type==='requestPreviewRender'&&message.layout==='full';
      const ready=held?new Promise(resolve=>{window.__releaseFullTransition=resolve}):Promise.resolve();
      ready.then(()=>window.__transitionHost(message)).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}))});
    }});` });
    await page.addScriptTag({ content: await build.outputs[0]!.text() });
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///source-preview-transition.md', text, version: 1, savedRevision: { version: 1, text },
      diagnostics: [], mode: 'source', uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark',
      previewFontFamily: '', previewSourceColoring: false, editorAppearance: 'dark', gitChangesGutter: false,
      gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false,
      fixedBaselineActive: false, contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: true, outlineWidth: 240,
      restoreReadingPositionOnOpen: false, vscodeTheme: null
    } })), text);
    await page.waitForFunction(() => !!document.querySelector('.cm-content') && !document.querySelector('.meo-preload-toolbar')
      && !document.querySelector<HTMLElement>('.editor-host')?.inert);
    await page.click('.source-preview-button');
    const ready = async (mode: 'source' | 'preview') => page.waitForFunction(mode => {
      const editor = document.querySelector<HTMLElement>('.editor-host')!;
      const host = document.querySelector<HTMLElement>('.preview-host')!;
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      return document.querySelector<HTMLElement>('#app')?.dataset.mode === mode && !host.hidden
        && getComputedStyle(host).visibility !== 'hidden' && host.querySelector<HTMLElement>('.preview-loading')?.hidden
        && host.getAttribute('aria-busy') !== 'true' && frame.contentDocument?.querySelector('.meo-export-doc')
        && frame.contentDocument.documentElement.inert === false && (mode === 'source'
          ? !editor.hidden && !editor.inert && document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
          : editor.hidden && !editor.hasAttribute('data-preview-cover') && getComputedStyle(frame).visibility !== 'hidden');
    }, {}, mode).catch(async error => {
      const state = await page.evaluate(() => ({ mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        surface: document.querySelector('.editor-surface')?.outerHTML.slice(0, 240),
        editor: document.querySelector('.editor-host')?.outerHTML.slice(0, 160),
        preview: document.querySelector('.preview-host')?.outerHTML.slice(0, 200),
        status: document.querySelector('.preview-status')?.textContent,
        frameInert: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.inert }));
      throw new Error(`Transition readiness (${windowed}/${mode}): ${JSON.stringify({ state, errors })}`, { cause: error });
    });
    await ready('source');
    assert.equal(windowRequests > 0, windowed, 'exercise the production windowed transport when policy selects it');
    if (windowed) assert.ok(await page.$eval('.preview-frame', (frame: HTMLIFrameElement) =>
      frame.contentDocument!.querySelectorAll('[data-meo-preview-block]').length < 150), 'large Preview keeps a bounded DOM');
    const snapshot = () => page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>('.editor-host')!;
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const loading = document.querySelector<HTMLElement>('.preview-loading')!;
      return { editorVisible: getComputedStyle(editor).display !== 'none' && getComputedStyle(editor).visibility !== 'hidden',
        frameVisible: getComputedStyle(frame).visibility !== 'hidden', loadingVisible: !loading.hidden,
        frameWidth: frame.getBoundingClientRect().width, surfaceWidth: document.querySelector('.editor-surface')!.getBoundingClientRect().width };
    });
    const firstFrameLoading = await page.evaluate(async () => {
      (window as any).__holdFullTransition = true;
      document.querySelector<HTMLButtonElement>('button[data-mode="preview"]')!.click();
      await new Promise(requestAnimationFrame);
      return !document.querySelector<HTMLElement>('.preview-loading')!.hidden;
    });
    assert.equal(firstFrameLoading, true, 'the first destination frame must contain feedback rather than a blank surface');
    await page.waitForFunction(() => !!(window as any).__releaseFullTransition);
    await page.evaluate(async () => { for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame); });
    const pending = await snapshot();
    if (process.env.MEO_TEST_SCREENSHOTS) {
      await mkdir(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `split-to-full-${windowed ? 'windowed' : 'ordinary'}-pending.png`) });
    }
    assert.equal(pending.editorVisible, false, `Source must leave with the split layout, without overlaying the full Preview: ${JSON.stringify(pending)}`);
    assert.equal(pending.loadingVisible, true, 'an empty full Preview must show loading immediately, without a silent background interval');
    assert.equal(pending.frameVisible, false, 'unfinished full-width iframe stays covered by loading feedback');
    assert.ok(Math.abs(pending.frameWidth - pending.surfaceWidth) <= 1, 'destination prepares at full width');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-loading')!.hidden);
    assert.equal((await snapshot()).editorVisible, false, 'slow loading keeps Source hidden');
    // Cancel the pending transition, then release its stale response.
    await page.click('button[data-mode="source"]');
    await ready('source');
    await page.evaluate(() => { (window as any).__holdFullTransition = false; (window as any).__releaseFullTransition(); });
    await page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); });
    await ready('source');
    assert.equal((await snapshot()).frameVisible, true, 'cancellation reveals the retained side Preview');
    await page.click('button[data-mode="preview"]');
    await ready('preview');
    assert.equal((await snapshot()).frameVisible, true, 'completed transition reveals the full Preview');
    await page.click('button[data-mode="source"]');
    await ready('source');
    assert.equal(await page.$eval('.cm-content', element => (element as any).cmTile.root.view.state.doc.toString()), text,
      'both transitions retain the complete source document');
    assert.deepEqual(errors, []);
    console.log(`Source split → full Preview transition (${windowed ? 'windowed' : 'ordinary'}): passed delayed rendering, cancellation and completion`);
    await page.close();
    for (const parsed of documents.values()) parsed.dispose();
  }
} catch (error) { primaryError = error; throw error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
