import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const lineEnding of ['\n', '\r\n']) for (const custom of [false, true]) for (const mode of ['live', 'source', 'preview'] as const) {
    let savedState: unknown;
    const manualMode = mode === 'live' ? 'source' : mode === 'source' ? 'preview' : 'live';
    for (const phase of ['startup', 'reload', 'manual-reload'] as const) {
      const expectedMode = phase === 'manual-reload' ? manualMode : mode;
      console.log(`Checking ${expectedMode} ${phase} (${custom ? 'custom' : 'default'} settings, ${lineEnding === '\n' ? 'LF' : 'CRLF'})`);
      const page = await browser.newPage();
      await page.setViewport({ width: 1000, height: 700 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      let renderRequests = 0;
      const renderSettings: Array<{ language: string; fontSize: number }> = [];
      await page.exposeFunction('__renderStartupPreview', async (message: any) => {
        if (message.type !== 'requestPreviewRender') return null;
        renderRequests += 1;
        renderSettings.push({ language: message.uiLanguage, fontSize: message.environment.editorFontSizePx });
        return {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({
            markdownText: message.text,
            sourceDocumentPath: 'C:/tmp/startup-load.md',
            uiLanguage: message.uiLanguage,
            styleEnvironment: message.environment
          }) }
        };
      });
      await page.evaluate(state => { (window as any).__startupState = state; }, savedState);
      await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return window.__startupState},setState(state){window.__startupState=JSON.parse(JSON.stringify(state))},postMessage(message){window.__renderStartupPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
      await page.addScriptTag({ content: bundle });
      const marker = `Startup content ${mode}`;
      const markdown = `# ${marker}${lineEnding}${lineEnding}The document body must load after opening.`;
      await page.evaluate(({ mode, markdown, custom }) => {
        const initMessage = {
          type: 'init', documentId: `file:///startup-${mode}.md`, text: markdown, version: 1,
          savedRevision: { version: 1, text: markdown }, diagnostics: [], mode, uiLanguage: custom ? 'zh-CN' : 'en',
          sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
          editorAppearance: 'dark', editorFontSizeMode: custom ? 'custom' : 'auto', editorFontSize: custom ? 32 : 14,
          gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
          diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
          contentMaxWidthEnabled: custom, findOptions: { wholeWord: false, caseSensitive: false },
          outlinePosition: 'right', outlineVisible: false, outlineWidth: custom ? 340 : 260,
          restoreReadingPositionOnOpen: custom, vscodeTheme: null
        };
        (window as typeof window & { __startupInit?: typeof initMessage }).__startupInit = initMessage;
        window.dispatchEvent(new MessageEvent('message', { data: initMessage }));
      }, { mode, markdown, custom });
      await page.waitForFunction(({ mode, marker }) => {
        if (document.querySelector('.meo-preload-toolbar')) return false;
        const root = document.querySelector<HTMLElement>('.editor-root');
        const selected = document.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`);
        const editor = document.querySelector<HTMLElement>('.editor-host');
        const preview = document.querySelector<HTMLElement>('.preview-host');
        if (root?.dataset.mode !== mode || selected?.getAttribute('aria-selected') !== 'true') return false;
        if (mode === 'preview') {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
          return preview?.hidden === false
            && document.querySelector<HTMLElement>('.preview-status')?.hidden === true
            && frame?.contentDocument?.querySelector('main.meo-export-doc')?.textContent?.includes(marker);
        }
        return editor?.hidden === false
          && editor.querySelector('.cm-content')?.textContent?.includes(marker);
      }, { timeout: 10000 }, { mode: expectedMode, marker }).catch(async error => {
        const state = await page.evaluate(() => ({
          mode: document.querySelector<HTMLElement>('.editor-root')?.dataset.mode,
          status: document.querySelector<HTMLElement>('.preview-status')?.textContent,
          editor: document.querySelector<HTMLElement>('.editor-host .cm-content')?.textContent,
          preview: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent
        }));
        throw new Error(`${expectedMode} ${phase} did not load content: ${JSON.stringify(state)}`, { cause: error });
      });
      assert.ok(renderSettings.length > 0, 'Startup must exercise the real Preview bridge');
      assert.equal(renderSettings[0]!.language, custom ? 'zh-CN' : 'en',
        'Initial Preview request must capture the configured UI language');
      if (custom) assert.equal(renderSettings[0]!.fontSize, 32,
        'Initial Preview request must capture the configured editor font size');
      savedState = await page.evaluate(() => (window as any).__startupState);
      if (phase === 'startup') assert.equal((savedState as { mode?: string } | undefined)?.mode, undefined,
        'Host initialization must not synthesize a local mode preference, including automatic Source');
      if (expectedMode === 'preview') {
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(renderRequests, 1, 'Opening Preview must reuse its in-flight initial presentation');
        await page.click('button[data-mode="source"]');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source');
        await page.evaluate(() => {
          const init = (window as typeof window & { __startupInit?: unknown }).__startupInit;
          window.dispatchEvent(new MessageEvent('message', { data: init }));
        });
        await new Promise(resolve => setTimeout(resolve, 150));
        const currentMode = await page.$eval('.editor-root', root => (root as HTMLElement).dataset.mode);
        assert.equal(currentMode, 'source', 'a delayed duplicate init must not reset a mode change');
      }
      if (phase === 'reload') {
        await page.click(`button[data-mode="${manualMode}"]`);
        await page.waitForFunction(mode => (window as any).__startupState?.mode === mode, {}, manualMode);
        savedState = await page.evaluate(() => (window as any).__startupState);
        assert.equal((savedState as { contentMaxWidthEnabled: boolean }).contentMaxWidthEnabled, custom);
        assert.equal((savedState as { outlineWidth: number }).outlineWidth, custom ? 340 : 260);
      }
      await page.close();
    }
  }
  console.log('Editor startup content checks passed: Live, Source, Preview');
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
