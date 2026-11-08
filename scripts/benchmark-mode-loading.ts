import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { createLargeDocumentFixtures } from './large-document-fixtures';
import exportRuntime from '../src/export/runtime';
import { shouldPreloadMermaid, webviewPreloadModules } from '../src/extension/webviewResourceHints';
import { getWebviewPreloadShellCss, getWebviewPreloadShellMarkup } from '../src/shared/webviewPreloadShell';
import { installModeLoadingReadiness } from './mode-loading-readiness';

if (!process.argv.includes('--confirm-long-run')) throw new Error('Repeated mode sampling requires --confirm-long-run');
const option = (name: string, fallback: string) => process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const rounds = process.argv.includes('--rounds') ? Number(option('--rounds', '5')) : 5;
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20);
const label = process.argv.includes('--label') ? option('--label', 'sample') : 'sample';
assert.match(label, /^[a-z0-9-]+$/);
const dist = path.resolve('webview/dist');
assert.ok(fs.existsSync(path.join(dist, 'index.js')), 'Build the production Webview first');
const allModes = ['live', 'source', 'preview'] as const;
const requestedMode = process.argv.includes('--mode') ? option('--mode', '') : undefined;
assert.ok(requestedMode === undefined || allModes.includes(requestedMode as typeof allModes[number]), 'Unknown mode');
const modes: readonly typeof allModes[number][] = requestedMode === undefined ? allModes : [requestedMode as typeof allModes[number]];
const startupOnly = process.argv.includes('--startup-only');
const viewport = { width: 1100, height: 720, deviceScaleFactor: 1 };
const fixtures: Array<{ kind: string; text: string }> = createLargeDocumentFixtures().filter(f => ['ordinary', 'rich-heavy', 'lines-heavy'].includes(f.kind));
fixtures.push({ kind: 'mention-only', text: fixtures[0]!.text + '\n\nThis guide discusses Mermaid without containing diagrams.' });
const selectedFixtures = process.argv.includes('--fixture')
  ? fixtures.filter(f => f.kind === option('--fixture', '')) : fixtures;
assert.ok(selectedFixtures.length > 0, 'Unknown fixture');
const samples: unknown[] = [];
const preloadMermaid = process.argv.includes('--preload-mermaid');
const assets = fs.readdirSync(dist, { recursive: true }).map(String).map(name => name.replaceAll(path.sep, '/'))
  .filter(name => /\.(js|css)$/.test(name)).sort();
const buildHash = createHash('sha256');
for (const name of assets) buildHash.update(name).update(fs.readFileSync(path.join(dist, name)));
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/') {
      const preloadModules = webviewPreloadModules(new URL(request.url).searchParams.has('preload'));
      return new Response('<!doctype html><style>' + getWebviewPreloadShellCss() + '</style><link rel="stylesheet" href="/index.css"><link rel="stylesheet" href="/katex/katex-embedded.css">'
        + preloadModules.map(module => `<link rel="modulepreload" href="/${module}">`).join('')
        + '<body class="vscode-dark" data-meo-mermaid-src="/mermaid.min.js" data-meo-mermaid-module-src="/mermaid/mermaidRuntime.js" data-meo-katex-src="/katex/katex-embedded.css"><div id="app">'
        + getWebviewPreloadShellMarkup() + '</div><script type="module" src="/index.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    }
    const file = path.resolve(dist, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(file));
  }
});
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
let primaryError: unknown;
try {
  for (let round = 0; round < rounds; round++) for (const fixture of selectedFixtures) for (const initialMode of modes) {
    // A separate context and disabled HTTP cache give each mode fresh Webview state.
    // This excludes VS Code activation, OS file-cache coldness and network latency.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors: string[] = [];
    let mermaidRequests = 0;
    page.on('request', request => { if (request.url().endsWith('/mermaid.min.js') || new URL(request.url()).pathname.startsWith('/mermaid/')) mermaidRequests += 1; });
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.setViewport(viewport);
      await page.setCacheEnabled(false);
      const init = {
        type: 'init', documentId: 'file:///mode-benchmark.md', text: fixture.text, version: 1,
        savedRevision: { version: 1, text: fixture.text }, diagnostics: [], mode: initialMode, uiLanguage: 'en',
        sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
        editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
        gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        restoreReadingPositionOnOpen: false, vscodeTheme: null
      };
      await page.exposeFunction('__hostMessage', (message: any) => {
        if (message.type === 'ready') return { ...init, pageId: message.pageId };
        if (message.type !== 'requestPreviewRender') return null;
        return {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({
            markdownText: message.text, sourceDocumentPath: 'C:/mode-benchmark.md',
            uiLanguage: message.uiLanguage, styleEnvironment: message.environment
          }) }
        };
      });
      await page.evaluateOnNewDocument(installModeLoadingReadiness);
      await page.evaluateOnNewDocument(() => {
        const scope = window as any;
        scope.__times = { ready: 0, init: 0, content: 0, interactive: 0 };
        scope.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: any) {
          if (message.type === 'ready' && !scope.__times.ready) scope.__times.ready = performance.now();
          scope.__hostMessage(message).then((response: any) => {
            if (!response) return;
            if (response.type === 'init' && !scope.__times.init) {
              scope.__times.init = performance.now();
              scope.__startupMode = response.mode;
            }
            window.dispatchEvent(new MessageEvent('message', { data: response }));
          });
        } });
        scope.__isReady = (mode: string) => scope.__modeLoadingReadiness(mode, 'Large document').content;
        scope.__isInteractive = (mode: string) => scope.__modeLoadingReadiness(mode, 'Large document').interactive;
        const observe = () => {
          const mode = scope.__startupMode;
          if (scope.__times.init) {
            const readiness = scope.__modeLoadingReadiness(mode, 'Large document');
            if (readiness.content && !scope.__times.content) scope.__times.content = performance.now();
            if (readiness.interactive && !scope.__times.interactive) scope.__times.interactive = performance.now();
          }
          if (!scope.__times.interactive) requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      });
      const preload = preloadMermaid ? /mermaid/i.test(fixture.text) : shouldPreloadMermaid(fixture.text);
      await page.goto(server.url.href + (preload ? '?preload=1' : ''), { waitUntil: 'load' });
      await page.waitForFunction(() => (window as any).__times.content > 0, { timeout: 60000 });
      await page.waitForFunction(() => (window as any).__times.interactive > 0, { timeout: 60000 });
      const startup = await page.evaluate(() => ({ ...(window as any).__times,
        mode: document.getElementById('app')?.dataset.mode,
        font: getComputedStyle(document.querySelector('.cm-content') ?? document.body).font
      }));
      assert.equal(startup.mode, initialMode, 'Startup must settle in the requested mode');
      if (!startupOnly) await new Promise(resolve => setTimeout(resolve, 300));
      const startupMermaidRequests = mermaidRequests;
      const startupMermaidExecuted = await page.evaluate(() => Boolean((window as any).mermaid));
      if (initialMode === 'source' && !preload) {
        assert.equal(startupMermaidRequests, 0, 'Source must not load the unused Mermaid runtime');
      }
      const switches = [];
      const visitedModes = new Set<string>([initialMode]);
      let from: string = initialMode;
      for (const to of startupOnly ? [] : ['source', 'preview', 'live', 'preview', 'source', 'live']) {
        if (to === from) continue;
        // Let async resources and the preceding transition settle before the next sample.
        await new Promise(resolve => setTimeout(resolve, 300));
        const transition = await page.evaluate(async mode => {
          const started = performance.now();
          document.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`)!.click();
          return await new Promise<{ contentDurationMs: number; interactiveDurationMs: number }>((resolve, reject) => {
            let contentDurationMs: number | undefined;
            const observe = () => {
              const readiness = (window as any).__modeLoadingReadiness(mode, 'Large document');
              if (readiness.content && contentDurationMs === undefined) contentDurationMs = performance.now() - started;
              if (readiness.interactive && contentDurationMs !== undefined) {
                resolve({ contentDurationMs, interactiveDurationMs: performance.now() - started });
              }
              else if (performance.now() - started > 60000) reject(new Error(`Transition timed out: ${mode}`));
              else requestAnimationFrame(observe);
            };
            requestAnimationFrame(observe);
          });
        }, to);
        switches.push({ from, to, firstVisit: !visitedModes.has(to), durationMs: transition.contentDurationMs,
          interactiveDurationMs: transition.interactiveDurationMs });
        visitedModes.add(to);
        from = to;
      }
      if (!startupOnly && fixture.kind === 'rich-heavy') {
        await page.waitForFunction(() => {
          const svg = document.querySelector('.meo-mermaid-block svg');
          return !!svg && svg.getBoundingClientRect().height > 0;
        }, { timeout: 30000 });
      }
      assert.deepEqual(errors, []);
      samples.push({ round, fixture: fixture.kind, initialMode, startup, startupMermaidRequests, startupMermaidExecuted, switches });
      console.log(`${label} ${round + 1}/${rounds} ${fixture.kind} ${initialMode}: ${Math.round(startup.content)} ms content, ${Math.round(startup.interactive)} ms interactive`);
    } finally { await context.close(); }
  }
  const report = {
    schemaVersion: 2,
    driverSha256: createHash('sha256').update(fs.readFileSync(import.meta.path)).digest('hex'),
    readinessSha256: createHash('sha256').update(fs.readFileSync(path.resolve('scripts/mode-loading-readiness.ts'))).digest('hex'),
    shellSha256: createHash('sha256').update(getWebviewPreloadShellCss()).update(getWebviewPreloadShellMarkup()).digest('hex'),
    hintSha256: createHash('sha256').update(fs.readFileSync('src/extension/webviewResourceHints.ts')).digest('hex'),
    label, rounds, requestedMode: requestedMode ?? 'all', startupOnly,
    preloadPolicy: preloadMermaid ? 'legacy-word-match' : 'fence-hint',
    preloadModules: { false: webviewPreloadModules(false), true: webviewPreloadModules(true) }, createdAt: new Date().toISOString(),
    readiness: {
      content: 'Historical first-content predicate.',
      interactive: 'First RAF where the selected target is visible, non-inert, not aria-busy and uncovered; Preview also requires a non-inert rendered document.'
    },
    head: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    buildSha256: buildHash.digest('hex'), browser: await browser.version(), bun: Bun.version,
    platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, viewport, cache: 'disabled; fresh browser context per startup',
    scope: startupOnly
      ? 'Built Webview plus in-process real Preview renderer; startup ready/content/interactive times from navigation. startup-only omits mode transitions and final rich-resource settlement. Excludes Extension Host activation, real VS Code IPC and OS cold file cache.'
      : 'Built Webview plus in-process real Preview renderer; startup ready/content/interactive times from navigation; transition durationMs is first-content and interactiveDurationMs is the first interactive frame. Excludes Extension Host activation, real VS Code IPC, OS cold file cache and final rich-resource settlement.',
    fixtures: selectedFixtures.map(f => ({ kind: f.kind, bytes: Buffer.byteLength(f.text), sha256: createHash('sha256').update(f.text).digest('hex') })), samples
  };
  const output = path.resolve('.local/probes', `mode-loading-${label}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${output}`);
} catch (error) { primaryError = error; }
finally {
  server.stop(true);
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
