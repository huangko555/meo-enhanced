import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import type { Page } from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { webviewPreloadModules } from '../src/extension/webviewResourceHints';
import { getWebviewPreloadShellCss, getWebviewPreloadShellMarkup } from '../src/shared/webviewPreloadShell';

async function checkEditorModulePreload(browser: Awaited<ReturnType<typeof launchTestBrowser>>, init: Record<string, unknown>) {
  const dist = path.resolve('webview/dist');
  assert.ok(fs.existsSync(path.join(dist, 'editor.js')), 'Build the production Webview before the startup contract');
  let releaseShell!: () => void;
  const shellHeld = new Promise<void>(resolve => { releaseShell = resolve; });
  let sawEditor!: () => void;
  const editorRequested = new Promise<void>(resolve => { sawEditor = resolve; });
  let editorRequests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const relative = decodeURIComponent(new URL(request.url).pathname).slice(1);
    if (!relative) return new Response(`<!doctype html><style>${getWebviewPreloadShellCss()}</style><link rel="stylesheet" href="/index.css">`
      + webviewPreloadModules(false).map(module => `<link rel="modulepreload" href="/${module}">`).join('')
      + `<body class="vscode-dark"><div id="app">${getWebviewPreloadShellMarkup()}</div><script type="module" src="/index.js"></script>`, { headers: { 'Content-Type': 'text/html' } });
    if (relative === 'index.js') await shellHeld;
    if (relative === 'editor.js') { editorRequests += 1; sawEditor(); }
    const file = path.resolve(dist, relative);
    return file.startsWith(dist + path.sep) && fs.existsSync(file) ? new Response(Bun.file(file)) : new Response('', { status: 404 });
  } });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.setCacheEnabled(false);
    await page.exposeFunction('__preloadHost', (message: any) => message.type === 'ready'
      ? { ...init, pageId: message.pageId, mode: 'source' }
      : message.type === 'requestPreviewRender' ? {
        type: 'previewRenderResult', requestId: message.requestId,
        result: { ok: true, value: exportRuntime.renderPreviewDocument({ markdownText: message.text,
          sourceDocumentPath: 'C:/tmp/startup-load.md', uiLanguage: message.uiLanguage, styleEnvironment: message.environment }) }
      } : null);
    await page.evaluateOnNewDocument(() => {
      const scope = window as any;
      scope.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: any) {
        scope.__preloadHost(message).then((response: any) => {
          if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
        });
      } });
    });
    const navigation = page.goto(server.url.href, { waitUntil: 'load' });
    // Observe immediately so a failed navigation cannot become an unhandled rejection.
    void navigation.catch(() => {});
    await Promise.race([editorRequested, new Promise((_, reject) => setTimeout(() => reject(new Error('Editor fetch waited for the held shell')), 5000))]);
    assert.equal(await page.$('.cm-editor'), null, 'Module preparation must not construct an editor ahead of initialization');
    assert.equal(await page.$eval('.meo-startup-loading', element =>
      !!element.textContent?.trim() && getComputedStyle(element).display !== 'none'), true,
    'The production HTML shell must show feedback while its JavaScript module is held');
    releaseShell();
    await navigation;
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source'
      && document.querySelector('.cm-content')?.textContent?.includes('Startup content')
      && document.querySelector<HTMLElement>('.editor-loading')?.hidden === true
      && document.querySelector<HTMLElement>('.editor-host')?.inert === false, { timeout: 10000 });
    assert.equal(editorRequests, 1, 'Mount must reuse the prepared module instead of fetching a second copy');
    assert.equal(await page.$('.meo-startup-loading'), null, 'Ready Source must retire the startup feedback');
    assert.deepEqual(errors, [], 'The separately emitted editor must retain the shell\'s shared runtime');
    console.log('Editor module prepared before shell execution and reused by Source mount');
  } finally { releaseShell(); await context.close(); server.stop(true); }
}

const builds = await Promise.all([
  Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' }),
  Bun.build({ entrypoints: ['webview/src/documentStatisticsWorker.ts'], target: 'browser', format: 'iife' })
]);
for (const build of builds) if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const [bundle, statisticsWorker] = await Promise.all(builds.map(build => build.outputs[0]!.text()));
const browser = await launchTestBrowser();
const observeStatistics = (page: Page) => page.evaluate(source => {
  const scope = window as any;
  scope.__startupStatistics = [];
  scope.__startupStatisticsLoads = [];
  scope.__startupStatisticsPosts = [];
  const ready = scope.__startupSurfaceReady = () => {
    const mode = document.querySelector<HTMLElement>('.editor-root')?.dataset.mode;
    if (document.querySelector('.meo-preload-toolbar')) return false;
    return mode === 'preview'
      ? document.querySelector<HTMLElement>('.preview-host')?.hidden === false
        && document.querySelector<HTMLElement>('.preview-loading')?.hidden === true
        && (document.querySelector<HTMLElement>('.preview-status')?.hidden === false
          || (!!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc')
            && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.inert === false))
      : document.querySelector<HTMLElement>('.editor-host')?.hidden === false
        && !!document.querySelector('.editor-host .cm-content')
        && document.querySelector<HTMLElement>('.editor-host')?.inert === false
        && document.querySelector<HTMLElement>('.editor-loading')?.hidden === true;
  };
  const uri = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  document.body.dataset.meoStatisticsWorkerSrc = uri;
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (input === uri) scope.__startupStatisticsLoads.push({ ready: ready() });
    return fetch(input, init);
  };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(data: any, ...args: any[]) {
    if (data && Array.isArray(data.selections)) scope.__startupStatisticsPosts.push({ ready: ready() });
    return Reflect.apply(post, this, [data, ...args]);
  };
}, statisticsWorker!);
let handoffInit: Record<string, unknown> | undefined;
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
      await observeStatistics(page);
      let renderRequests = 0;
      const renderSettings: Array<{ language: string; fontSize: number }> = [];
      const holdInitialPreview = phase === 'startup' && mode === 'preview' && !custom && lineEnding === '\n';
      let releaseInitialPreview: (() => void) | undefined;
      const initialPreview = holdInitialPreview ? new Promise<void>(resolve => { releaseInitialPreview = resolve; }) : Promise.resolve();
      await page.exposeFunction('__renderStartupPreview', async (message: any) => {
        if (message.type !== 'requestPreviewRender') return null;
        renderRequests += 1;
        renderSettings.push({ language: message.uiLanguage, fontSize: message.environment.editorFontSizePx });
        await initialPreview;
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
      await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return window.__startupState},setState(state){window.__startupState=JSON.parse(JSON.stringify(state))},postMessage(message){if(message.type==='documentStatistics')window.__startupStatistics.push(message.statistics);window.__renderStartupPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
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
      handoffInit ??= await page.evaluate(() => (window as any).__startupInit);
      if (holdInitialPreview) {
        try {
          await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')?.hidden === false);
          assert.equal(await page.evaluate(() => (window as any).__startupStatisticsLoads.length), 0,
            'Full-document statistics must wait for the initial reading surface, including a delayed Preview');
        } finally { releaseInitialPreview?.(); }
      }
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
      await page.waitForFunction(() => (window as any).__startupStatistics.some((statistics: any) => statistics?.words === 10), { timeout: 10000 });
      const statisticsLoads = await page.evaluate(() => (window as any).__startupStatisticsLoads as Array<{ ready: boolean }>);
      assert.ok(statisticsLoads.length > 0 && statisticsLoads.every(load => load.ready),
        'Real statistics worker loading must follow the current interactive surface');
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
  assert.ok(handoffInit);
  for (const destination of ['source', 'live', 'preview', 'failed-preview'] as const) {
    console.log(`Checking statistics readiness handoff: pending Preview / ${destination}`);
    const page = await browser.newPage();
    let releasePreview: () => void = () => {};
    const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
    try {
      await page.setViewport({ width: 1000, height: 700 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await observeStatistics(page);
      await page.exposeFunction('__renderStartupPreview', async (message: any) => {
        if (message.type !== 'requestPreviewRender') return null;
        await previewGate;
        if (destination === 'failed-preview') return {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: false, error: { code: 'operation-failed', message: 'Controlled initial Preview failure' } }
        };
        return {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({ markdownText: message.text,
            sourceDocumentPath: 'C:/tmp/statistics-handoff.md', uiLanguage: message.uiLanguage,
            styleEnvironment: message.environment }) }
        };
      });
      await page.addScriptTag({ content: `window.__startupPreviewDeliveries=0;window.acquireVsCodeApi=()=>({getState(){},setState(state){window.__startupState=state},postMessage(message){if(message.type==='documentStatistics')window.__startupStatistics.push(message.statistics);window.__renderStartupPreview(message).then(response=>{if(response){window.__startupPreviewDeliveries++;window.dispatchEvent(new MessageEvent('message',{data:response}));}});}});` });
      await page.addScriptTag({ content: bundle });
      const text = '# Startup content handoff\n\nThe document body must load after opening.';
      await page.evaluate(input => window.dispatchEvent(new MessageEvent('message', { data: input })), {
        ...handoffInit, documentId: `file:///statistics-handoff-${destination}.md`, text,
        savedRevision: { version: 1, text }, mode: destination === 'preview' ? 'source' : 'preview'
      });
      if (destination === 'failed-preview') {
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')?.hidden === false);
        assert.equal(await page.evaluate(() => (window as any).__startupStatisticsLoads.length), 0,
          'A pending failed Preview must not start statistics before reaching its terminal surface');
        releasePreview();
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === false
          && (window as any).__startupSurfaceReady(), { timeout: 10000 });
        await page.waitForFunction(() => (window as any).__startupStatistics.some((s: any) => s?.words === 10 && s.line === null), { timeout: 10000 });
      } else if (destination === 'preview') {
        await page.waitForFunction(() => (window as any).__startupSurfaceReady(), { timeout: 10000 });
        await page.waitForFunction(() => (window as any).__startupStatistics.some((s: any) => s?.words === 10), { timeout: 10000 });
        const posts = await page.evaluate(() => (window as any).__startupStatisticsPosts.length);
        await page.click('button[data-mode="preview"]');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')?.hidden === false);
        assert.equal(await page.evaluate(() => (window as any).__startupStatisticsPosts.length), posts,
          'Statistics must wait for the pending Preview even when its worker already has an index');
        releasePreview();
        await page.waitForFunction(() => (window as any).__startupSurfaceReady()
          && (window as any).__startupStatistics.some((s: any) => s?.words === 10 && s.line === null), { timeout: 10000 });
      } else {
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')?.hidden === false);
        assert.equal(await page.evaluate(() => (window as any).__startupStatisticsLoads.length), 0);
        await page.click(`button[data-mode="${destination}"]`);
        await page.waitForFunction(mode => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode
          && (window as any).__startupSurfaceReady(), { timeout: 10000 }, destination);
        await page.waitForFunction(() => (window as any).__startupStatistics.some((s: any) => s?.words === 10 && s.line !== null), { timeout: 10000 });
        assert.equal(await page.evaluate(() => (window as any).__startupPreviewDeliveries), 0,
          'The accepted Editor must publish without waiting for the obsolete initial Preview');
        releasePreview();
        await page.waitForFunction(() => (window as any).__startupPreviewDeliveries > 0);
        assert.equal(await page.$eval('.editor-root', root => (root as HTMLElement).dataset.mode), destination,
          'A late initial Preview must not take the accepted Editor back');
      }
      const observed = await page.evaluate(() => ({ loads: (window as any).__startupStatisticsLoads,
        posts: (window as any).__startupStatisticsPosts }));
      assert.equal(observed.loads.length, 1, 'A handoff must not restart the statistics worker');
      assert.ok(observed.loads.every((load: { ready: boolean }) => load.ready)
        && observed.posts.every((post: { ready: boolean }) => post.ready), 'Only an accepted current reading surface may start statistics');
      console.log(`Statistics readiness handoff passed: pending Preview / ${destination}`);
    } finally { releasePreview(); await page.close(); }
  }
  await checkEditorModulePreload(browser, handoffInit!);
  console.log('Editor startup content checks passed: Live, Source, Preview and pending statistics handoffs');
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
