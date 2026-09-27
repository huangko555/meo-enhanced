import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { createLargeDocumentFixtures } from './large-document-fixtures';
import exportRuntime from '../src/export/runtime';
import { shouldPreloadMermaid } from '../src/extension/webviewResourceHints';

if (!process.argv.includes('--confirm-long-run')) throw new Error('Repeated mode sampling requires --confirm-long-run');
const option = (name: string, fallback: string) => process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const rounds = process.argv.includes('--rounds') ? Number(option('--rounds', '5')) : 5;
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20);
const label = process.argv.includes('--label') ? option('--label', 'sample') : 'sample';
assert.match(label, /^[a-z0-9-]+$/);
const dist = path.resolve('webview/dist');
assert.ok(fs.existsSync(path.join(dist, 'index.js')), 'Build the production Webview first');
const modes = ['live', 'source', 'preview'] as const;
const viewport = { width: 1100, height: 720, deviceScaleFactor: 1 };
const fixtures: Array<{ kind: string; text: string }> = createLargeDocumentFixtures().filter(f => ['ordinary', 'rich-heavy', 'lines-heavy'].includes(f.kind));
fixtures.push({ kind: 'mention-only', text: fixtures[0]!.text + '\n\nThis guide discusses Mermaid without containing diagrams.' });
const selectedFixtures = process.argv.includes('--fixture')
  ? fixtures.filter(f => f.kind === option('--fixture', '')) : fixtures;
assert.ok(selectedFixtures.length > 0, 'Unknown fixture');
const samples: unknown[] = [];
const preloadMermaid = process.argv.includes('--preload-mermaid');
const assets = fs.readdirSync(dist).filter(name => /\.(js|css)$/.test(name)).concat('katex/katex-embedded.css').sort();
const buildHash = createHash('sha256');
for (const name of assets) buildHash.update(name).update(fs.readFileSync(path.join(dist, name)));
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/') return new Response('<!doctype html><link rel="stylesheet" href="/index.css"><link rel="stylesheet" href="/katex/katex-embedded.css"><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark" data-meo-mermaid-src="/mermaid.min.js" data-meo-katex-src="/katex/katex-embedded.css"><div id="app"></div>' + (new URL(request.url).searchParams.has('preload') ? '<script src="/mermaid.min.js"></script>' : '') + '<script type="module" src="/index.js"></script>', { headers: { 'Content-Type': 'text/html' } });
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
    page.on('request', request => { if (request.url().endsWith('/mermaid.min.js')) mermaidRequests += 1; });
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
        if (message.type === 'ready') return init;
        if (message.type !== 'requestPreviewRender') return null;
        return {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({
            markdownText: message.text, sourceDocumentPath: 'C:/mode-benchmark.md',
            uiLanguage: message.uiLanguage, styleEnvironment: message.environment
          }) }
        };
      });
      await page.evaluateOnNewDocument(() => {
        const scope = window as any;
        scope.__times = { ready: 0, init: 0, content: 0 };
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
        scope.__isReady = (mode: string) => {
          const root = document.getElementById('app');
          const host = document.querySelector<HTMLElement>('.editor-host');
          if (root?.dataset.mode !== mode || document.querySelector(`button[data-mode="${mode}"]`)?.getAttribute('aria-selected') !== 'true') return false;
          if (mode === 'preview') return !host?.hasAttribute('data-preview-cover')
            && document.querySelector<HTMLElement>('.preview-host')?.hidden === false
            && document.querySelector<HTMLElement>('.preview-status')?.hidden === true
            && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc')?.textContent?.includes('Large document');
          return host?.hidden === false && !!host.querySelector('.cm-content')?.textContent?.includes('Large document');
        };
        const observe = () => {
          const mode = scope.__startupMode;
          if (scope.__times.init && scope.__isReady(mode)) scope.__times.content = performance.now();
          else requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      });
      const preload = preloadMermaid ? /mermaid/i.test(fixture.text) : shouldPreloadMermaid(fixture.text);
      await page.goto(server.url.href + (preload ? '?preload=1' : ''), { waitUntil: 'load' });
      await page.waitForFunction(() => (window as any).__times.content > 0, { timeout: 60000 });
      const startup = await page.evaluate(() => ({ ...(window as any).__times,
        mode: document.getElementById('app')?.dataset.mode,
        font: getComputedStyle(document.querySelector('.cm-content') ?? document.body).font
      }));
      assert.equal(startup.mode, initialMode, 'Startup must settle in the requested mode');
      await new Promise(resolve => setTimeout(resolve, 300));
      const startupMermaidRequests = mermaidRequests;
      if (initialMode === 'source' && !preload) {
        assert.equal(startupMermaidRequests, 0, 'Source must not load the unused Mermaid runtime');
      }
      const switches = [];
      const visitedModes = new Set<string>([initialMode]);
      let from: string = initialMode;
      for (const to of ['source', 'preview', 'live', 'preview', 'source', 'live']) {
        if (to === from) continue;
        // Let async resources and the preceding transition settle before the next sample.
        await new Promise(resolve => setTimeout(resolve, 300));
        const durationMs = await page.evaluate(async mode => {
          const started = performance.now();
          document.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`)!.click();
          await new Promise<void>((resolve, reject) => {
            const observe = () => {
              if ((window as any).__isReady(mode)) resolve();
              else if (performance.now() - started > 60000) reject(new Error(`Transition timed out: ${mode}`));
              else requestAnimationFrame(observe);
            };
            requestAnimationFrame(observe);
          });
          return performance.now() - started;
        }, to);
        switches.push({ from, to, firstVisit: !visitedModes.has(to), durationMs });
        visitedModes.add(to);
        from = to;
      }
      if (fixture.kind === 'rich-heavy') {
        await page.waitForFunction(() => {
          const svg = document.querySelector('.meo-mermaid-block svg');
          return !!svg && svg.getBoundingClientRect().height > 0;
        }, { timeout: 30000 });
      }
      assert.deepEqual(errors, []);
      samples.push({ round, fixture: fixture.kind, initialMode, startup, startupMermaidRequests, switches });
      console.log(`${label} ${round + 1}/${rounds} ${fixture.kind} ${initialMode}: ${Math.round(startup.content)} ms`);
    } finally { await context.close(); }
  }
  const report = {
    schemaVersion: 1,
    driverSha256: createHash('sha256').update(fs.readFileSync(import.meta.path)).digest('hex'),
    hintSha256: createHash('sha256').update(fs.readFileSync('src/extension/webviewResourceHints.ts')).digest('hex'),
    label, rounds, preloadPolicy: preloadMermaid ? 'legacy-word-match' : 'fence-hint', createdAt: new Date().toISOString(),
    head: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    buildSha256: buildHash.digest('hex'), browser: await browser.version(), bun: Bun.version,
    platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, viewport, cache: 'disabled; fresh browser context per startup',
    scope: 'Built Webview plus in-process real Preview renderer; ready/content times from navigation; transitions from DOM click to first ready frame. Excludes Extension Host activation, real VS Code IPC, OS cold file cache and final rich-resource settlement.',
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
