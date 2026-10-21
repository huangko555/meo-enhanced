import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

if (!process.argv.includes('--confirm-long-run')) throw new Error('Use --confirm-long-run for repeated strategy measurements');
const option = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const rounds = Number(option('--rounds', '3'));
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10);
const strategies = option('--strategies', 'auto,synchronous,bounded,windowed').split(',');
assert.ok(strategies.every(value => ['auto', 'synchronous', 'bounded', 'windowed', 'preview-window'].includes(value)));
const phase = option('--phase', 'full');
assert.ok(['full', 'startup', 'interaction'].includes(phase));
const modes = option('--modes', 'live,preview').split(',');
assert.ok(modes.every(value => ['live', 'source', 'preview'].includes(value)));
const root = path.resolve(import.meta.dir, '..');
const assets = path.resolve(option('--dist', 'webview/dist'));
const output = path.resolve('.local/strategy-comparison-' + option('--label', String(Date.now())));
assert.ok(output.startsWith(path.join(root, '.local') + path.sep));
fs.mkdirSync(output, { recursive: true });
const compiled = path.join(output, 'webview');
const policyPlugin = { name: 'benchmark-only-policy', setup(builder: any) {
  builder.onLoad({ filter: /[\\/]foundation[\\/]largeDocument\.ts$/ }, async ({ path: filename }: { path: string }) => {
    const source = await Bun.file(filename).text();
    const header = 'export function assessLargeDocument(text: string): LargeDocumentAssessment {';
    assert.equal(source.split(header).length, 2);
    return { loader: 'ts', contents: source.replace(header, 'function originalAssessment(text: string): LargeDocumentAssessment {') + `
      export function assessLargeDocument(text: string): LargeDocumentAssessment {
        const result = originalAssessment(text), strategy = (globalThis as any).__strategyComparison;
        if (!strategy || strategy === 'auto') return result;
        return { ...result, boundedEditorWork: strategy !== 'synchronous', preferSource: strategy === 'windowed',
          lightweightSourceSyntax: strategy === 'windowed', windowedPreview: strategy === 'windowed' || strategy === 'preview-window' };
      }` };
  });
} };
const build = await Bun.build({ entrypoints: [path.join(root, 'webview/src/index.ts')], target: 'browser', format: 'esm',
  splitting: true, minify: true, outdir: compiled, plugins: [policyPlugin] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const hostEntry = path.join(output, 'host-entry.ts');
fs.writeFileSync(hostEntry, `export { default as runtime } from ${JSON.stringify(path.join(root, 'src/export/runtime.ts'))};
export { createPreviewDocument } from ${JSON.stringify(path.join(root, 'src/export/previewDocument.ts'))};`);
const hostBuild = await Bun.build({ entrypoints: [hostEntry], target: 'bun', format: 'esm', minify: true,
  outdir: path.join(output, 'host'), plugins: [policyPlugin] });
assert.ok(hostBuild.success, hostBuild.logs.map(String).join('\n'));
const host = await import(pathToFileURL(hostBuild.outputs[0]!.path).href);
const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const rich = (index: number) => `## Rich ${index}\n\n| Name | Value |\n| --- | --- |\n| Item ${index} | **value** |\n\n`
  + '```javascript\nconst value = 123;\n```\n\n' + `$$\nx_{${index}}^2+1\n$$\n\n![pixel](${pixel})\n\n`
  + (index % 10 === 0 ? '```mermaid\nflowchart LR\nA-->B\n```\n\n' : '');
const prefix = '# Strategy comparison\n\nBENCH_EDIT_TARGET\n\nStable **bold** content and [link](https://example.com).\n\n';
const suffix = '\n\n## LOCATION_TAIL\n\nBENCH_DOCUMENT_END\n';
const fixtures = [
  { kind: 'small-simple', text: prefix + 'A simple paragraph.\n\n'.repeat(15) + suffix },
  { kind: 'small-complex', text: prefix + Array.from({ length: 40 }, (_, i) => rich(i)).join('') + suffix },
  { kind: 'code-dense', text: prefix + '```\nplain code content\n```\n\n'.repeat(60) + suffix },
  { kind: 'medium-prose', text: prefix + 'A paragraph with **bold** and [link](https://example.com).\n\n'.repeat(900) + suffix },
  { kind: 'large-mixed', text: prefix + Array.from({ length: 120 }, (_, i) => rich(i) + 'Ordinary **formatted** paragraph with enough source text.\n\n'.repeat(160)).join('') + suffix },
  { kind: 'giant-line', text: prefix + 'Long single paragraph '.repeat(24_000) + suffix },
  { kind: 'giant-code', text: prefix + '```javascript\n' + 'const value = { text: "content", number: 123 };\n'.repeat(18_000) + '```' + suffix },
  { kind: 'giant-table', text: prefix + '| Name | Value |\n| --- | --- |\n' + Array.from({ length: 1600 }, (_, i) => `| Row ${i} | Long **formatted** content ${i} |\n`).join('') + suffix },
  ...[200, 400, 800, 1200].map(rows => ({ kind: `table-${rows}`, text: prefix + '| Name | Value |\n| --- | --- |\n'
    + Array.from({ length: rows }, (_, i) => `| Row ${i} | Long **formatted** content ${i} |\n`).join('') + suffix }))
].filter(fixture => option('--fixtures', '').split(',').filter(Boolean).length === 0 || option('--fixtures', '').split(',').includes(fixture.kind));
assert.ok(fixtures.length > 0);
const report: any = { commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(), rounds, phase,
  cpuProfile: process.argv.includes('--cpu-profile'),
  driverSha256: createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex'),
  policySha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'src/foundation/largeDocument.ts'))).digest('hex'),
  compiledSha256: createHash('sha256').update(fs.readFileSync(path.join(compiled, 'index.js'))).digest('hex'),
  browser: '', viewport: { width: 1280, height: 900 }, assets: createHash('sha256').update(fs.readFileSync(path.join(assets, 'index.js'))).digest('hex'),
  scope: 'Fresh browser contexts and disabled HTTP cache for each direct opening; warm means revisiting a mode in the same session. OS caches are not cleared. Host rendering runs in a separate Bun process from Chromium, not the VS Code extension Host. Click/input includes CDP dispatch, source/selection confirmation and two animation frames; heap is renderer JS heap, not total RAM.',
  fixtures: fixtures.map(fixture => ({ kind: fixture.kind, sha256: createHash('sha256').update(fixture.text).digest('hex'),
    ...assessLargeDocument(fixture.text), maxLine: Math.max(...fixture.text.split('\n').map(line => line.length)) })), samples: [] };
for (const fixture of fixtures) fs.writeFileSync(path.join(output, fixture.kind + '.md'), fixture.text);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  if (pathname === '/') return new Response('<!doctype html><link rel="stylesheet" href="/index.css"><link rel="stylesheet" href="/katex/katex-embedded.css">'
    + '<style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark" data-meo-katex-src="/katex/katex-embedded.css" data-meo-mermaid-module-src="/mermaid/mermaidRuntime.js" data-meo-shiki-worker-src="/shiki-highlight-worker.js" data-meo-markdown-worker-src="/markdown-parse-worker.js" data-meo-git-diff-worker-src="/git-diff-worker.js"><div id="app"></div><script type="module" src="/index.js"></script>',
  { headers: { 'Content-Type': 'text/html' } });
  for (const directory of [compiled, assets]) {
    const file = path.resolve(directory, '.' + pathname);
    if (file.startsWith(directory + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return new Response(Bun.file(file),
      { headers: /\.js$/.test(file) ? { 'Content-Type': 'text/javascript' } : {} });
  }
  return new Response('Missing', { status: 404 });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frames = (page: any) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
let primary: unknown;
try {
  report.browser = await browser.version();
  campaign: for (let round = 0; round < rounds; round++) for (const fixture of fixtures) {
    // Rotate strategy order to reduce one-direction JIT/cache and thermal bias.
    const ordered = [...strategies.slice(round % strategies.length), ...strategies.slice(0, round % strategies.length)];
    for (const strategy of ordered) for (const initialMode of modes) {
      if (fs.existsSync(path.join(output, 'STOP'))) { report.stopped = true; break campaign; }
      (globalThis as any).__strategyComparison = strategy;
      const context = await browser.createBrowserContext(), page = await context.newPage();
      const profiler = process.argv.includes('--cpu-profile') ? await page.createCDPSession() : undefined;
      if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
      page.setDefaultTimeout(20_000);
      await page.setViewport(report.viewport); await page.setCacheEnabled(false);
      const sample: any = { round, fixture: fixture.kind, strategy, initialMode, errors: [], hostRenders: [] };
      let currentText = fixture.text, version = 1;
      const documents = new Map<string, any>();
      page.on('pageerror', error => sample.errors.push(String(error)));
      await page.exposeFunction('__strategyHost', async (message: any) => {
        if (message.type === 'ready') return { type: 'init', documentId: 'file:///strategy.md', text: currentText, version,
          savedRevision: { text: currentText, version }, diagnostics: [], mode: initialMode, uiLanguage: 'en', sourceLineNumbers: 'on',
          previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark',
          editorFontSizeMode: 'auto', editorFontSize: 14, gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
          diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
          largeDocumentOptimizationEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
          outlineVisible: false, outlineWidth: 260, restoreReadingPositionOnOpen: false, vscodeTheme: null };
        if (message.type === 'applyChanges') {
          assert.equal(message.baseVersion, version);
          for (const change of [...message.changes].sort((a: any, b: any) => b.from - a.from)) currentText = currentText.slice(0, change.from) + change.insert + currentText.slice(change.to);
          return { type: 'applied', version: ++version };
        }
        if (message.type === 'requestPreviewRender') {
          const started = performance.now(), options = { markdownText: message.text, sourceDocumentPath: 'C:/strategy.md',
            uiLanguage: 'en', styleEnvironment: message.environment, preset: message.preset };
          const document = message.window ? host.createPreviewDocument(message.requestId, options) : undefined;
          if (document) documents.set(message.requestId, document);
          const value = document ? document.open(message.window.anchorLine) : host.runtime.renderPreviewDocument(options);
          sample.hostRenders.push({ ms: performance.now() - started, windowed: !!document });
          return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } };
        }
        if (message.type === 'requestPreviewDocument') return { type: 'previewDocumentResult', documentId: message.documentId,
          requestId: message.requestId, result: { ok: true, value: await documents.get(message.documentId).run(message.operation) } };
        return null;
      });
      await page.evaluateOnNewDocument(({ strategy, initialMode }) => {
        const scope = window as any;
        scope.__strategyComparison = strategy; scope.__strategyLongTasks = []; scope.__strategyEvents = []; scope.__strategyReadyAt = 0;
        new PerformanceObserver(list => { for (const entry of list.getEntries()) scope.__strategyLongTasks.push({ start: entry.startTime, ms: entry.duration }); }).observe({ type: 'longtask', buffered: true });
        new PerformanceObserver(list => { for (const entry of list.getEntries() as any) scope.__strategyEvents.push({ name: entry.name,
          start: entry.startTime, ms: entry.duration, queueMs: entry.processingStart - entry.startTime }); }).observe({ type: 'event', durationThreshold: 16 } as any);
        scope.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: any) {
          if (message.type === 'ready') scope.__strategyInitAt = performance.now();
          scope.__strategyHost(message).then((data: any) => { if (data) window.dispatchEvent(new MessageEvent('message', { data })); });
        } });
        scope.__strategyReady = (mode: string) => {
          if (document.getElementById('app')?.dataset.mode !== mode || document.querySelector('.mode-group [aria-busy="true"]')) return false;
          if (document.querySelector('.meo-preload-toolbar, .meo-preload-editor-shell')) return false;
          const host = document.querySelector<HTMLElement>('.editor-host');
          if (!host || host.hasAttribute('data-preview-cover')) return false;
          if (mode === 'preview') return document.querySelector<HTMLElement>('.preview-host')?.hidden === false
            && document.querySelector<HTMLElement>('.preview-status')?.hidden === true
            && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc');
          return !host.hidden && !host.hasAttribute('inert') && !!host.querySelector('.cm-content')?.textContent?.trim();
        };
        const ready = () => { if (scope.__strategyInitAt && scope.__strategyReady(initialMode)) scope.__strategyReadyAt = performance.now(); else requestAnimationFrame(ready); };
        requestAnimationFrame(ready);
      }, { strategy, initialMode });
      const switchMode = async (mode: string) => {
        const start = performance.now(); await page.$eval(`button[data-mode="${mode}"]`, (element: any) => element.click());
        await page.waitForFunction(mode => (window as any).__strategyReady(mode), {}, mode); await frames(page);
        return performance.now() - start;
      };
      try {
        const navigationStarted = performance.now();
        await page.goto(server.url.href, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window as any).__strategyReadyAt > 0);
        sample.startup = await page.evaluate(() => ({ navigationMs: (window as any).__strategyReadyAt,
          initMs: (window as any).__strategyReadyAt - (window as any).__strategyInitAt }));
        sample.startup.observedNavigationMs = performance.now() - navigationStarted;
        if (phase === 'startup') {
          if (initialMode !== 'preview') {
            const coords = await page.evaluate(() => {
              const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
              const pos = view.state.doc.toString().indexOf('BENCH_EDIT_TARGET') + 17, rect = view.coordsAtPos(pos);
              return { x: rect.left, y: (rect.top + rect.bottom) / 2, pos };
            });
            const clickStart = performance.now(); await page.mouse.click(coords.x, coords.y); await frames(page);
            const clickMs = performance.now() - clickStart;
            const selected = await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.selection.main.head);
            sample.coldInteraction = { clickMs, target: coords.pos, selected };
            assert.ok(Math.abs(selected - coords.pos) <= 1, 'cold trusted click must place the caret in the requested text');
            const issued = performance.now(); await page.keyboard.type('8'); await frames(page);
            sample.coldInteraction.inputMs = performance.now() - issued;
            await page.waitForFunction(() => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.doc.toString().includes('BENCH_EDIT_TARGET8'));
          } else {
            const scrollStarted = performance.now();
            const geometry = await page.$eval('.preview-frame', (frame: HTMLIFrameElement) => {
              const rect = frame.getBoundingClientRect(), scroller = frame.contentDocument!.scrollingElement!;
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
                top: scroller.scrollTop, scrollable: scroller.scrollHeight > scroller.clientHeight + 4 };
            });
            if (geometry.scrollable) {
              await page.mouse.move(geometry.x, geometry.y); await page.mouse.wheel({ deltaY: 180 });
              await page.waitForFunction(top => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop !== top, {}, geometry.top);
              await frames(page);
              sample.coldScroll = { commandToResultMs: performance.now() - scrollStarted };
            }
          }
          sample.startup.confirmedInteractiveNavigationMs = performance.now() - navigationStarted;
          sample.longTasks = await page.evaluate(() => (window as any).__strategyLongTasks);
          sample.eventTimings = await page.evaluate(() => (window as any).__strategyEvents);
          assert.deepEqual(sample.errors, [], 'direct opening must not produce browser exceptions');
          continue;
        }
        await sleep(250);
        sample.switches = [];
        for (const mode of ['live', 'source', 'preview', 'live', 'preview']) {
          if (await page.$eval('#app', (app, mode) => (app as HTMLElement).dataset.mode === mode, mode)) continue;
          sample.switches.push({ to: mode, ms: await switchMode(mode) });
        }
        sample.interactions = [];
        for (const mode of ['live', 'source']) {
          await switchMode(mode);
          const point = await page.evaluate(() => {
            const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
            const position = view.state.doc.toString().indexOf('BENCH_EDIT_TARGET') + 'BENCH_EDIT_TARGET'.length;
            view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
            return { position };
          });
          await frames(page);
          const coords = await page.evaluate(position => {
            const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view, rect = view.coordsAtPos(position);
            return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
          }, point.position);
          const clickStart = performance.now(); await page.mouse.click(coords.x, coords.y); await frames(page);
          const clickMs = performance.now() - clickStart;
          const selected = await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.selection.main.head);
          assert.ok(Math.abs(selected - point.position) <= 1, 'trusted click must place the caret in the requested text');
          const expectedBefore = currentText, samples = [];
          for (let i = 0; i < 8; i++) {
            const started = performance.now(); await page.keyboard.type('7'); await frames(page); samples.push(performance.now() - started);
          }
          await sleep(400);
          assert.equal(currentText, expectedBefore.slice(0, selected) + '77777777' + expectedBefore.slice(selected));
          if (mode === 'source') sample.sourceColoring = await page.$$eval('.editor-host .meo-source-token', nodes => nodes.length);
          sample.interactions.push({ mode, clickMs, inputMs: samples });
        }
        if (fixture.kind.includes('table')) {
          await switchMode('live');
          const nativeSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea';
          await page.click(nativeSelector);
          await page.$eval(nativeSelector, (input: HTMLTextAreaElement) => input.setSelectionRange(0, 0));
          await frames(page);
          const native = await page.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea')!;
            const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
            const rect = input.getBoundingClientRect(), bounds = view.scrollDOM.getBoundingClientRect();
            if (rect.top < bounds.top || rect.bottom > bounds.bottom) throw new Error('Native input must start in a visible cell');
            return { value: input.value, scroll: view.scrollDOM.scrollTop };
          });
          const beforeNative = currentText, times = [];
          for (let i = 0; i < 8; i++) {
            const issued = performance.now(); await page.keyboard.type('7'); await frames(page); times.push(performance.now() - issued);
          }
          await sleep(750);
          const afterNative = await page.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea')!;
            const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
            return { value: input.value, caret: input.selectionStart, scroll: view.scrollDOM.scrollTop };
          });
          sample.nativeTable = { inputMs: times, before: native, after: afterNative };
          assert.equal(afterNative.value, '77777777' + native.value);
          assert.equal(afterNative.caret, 8, 'native numeric input must keep its insertion caret');
          assert.equal(currentText, beforeNative.replace('| ' + native.value + ' |', '| 77777777' + native.value + ' |'));
          assert.ok(Math.abs(afterNative.scroll - native.scroll) <= 1.5, 'table input and its delayed commit must retain the viewport');
        }
        await switchMode('preview');
        sample.previewWitness = await page.evaluate(() => {
          const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
          return { bold: [...doc.querySelectorAll('strong')].some(element => element.textContent === 'bold'),
            link: [...doc.querySelectorAll('a')].some(element => element.textContent === 'link'
              && [...element.attributes].some(attribute => attribute.value.includes('https://example.com'))),
            windowed: !!doc.querySelector('.meo-preview-virtual-gap') };
        });
        assert.ok(sample.previewWitness.bold && sample.previewWitness.link);
        sample.scroll = await page.evaluate(async () => {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!, scroll = doc.scrollingElement!;
          const gaps: number[] = []; let previous = performance.now();
          for (let i = 0; i < 16; i++) {
            scroll.scrollTop = i % 2 === 0 ? scroll.scrollHeight * 0.7 : scroll.scrollHeight * 0.15;
            await new Promise(resolve => requestAnimationFrame(resolve)); const now = performance.now(); gaps.push(now - previous); previous = now;
          }
          scroll.scrollTop = 0; return { frameMs: gaps };
        });
        await sleep(250); await frames(page);
        await switchMode('source');
        await page.focus('.editor-host .cm-content');
        await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
        await frames(page);
        const tail = await page.evaluate(() => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          const bounds = view.scrollDOM.getBoundingClientRect(), content = view.contentDOM.getBoundingClientRect();
          const reading = view.posAtCoords({ x: Math.max(bounds.left + 50, content.left + 2), y: bounds.top + view.scrollDOM.clientHeight / 3 });
          return { head: view.state.selection.main.head, scroll: view.scrollDOM.scrollTop, reading,
            line: reading === null ? null : view.state.doc.lineAt(reading).number };
        });
        await frames(page); await switchMode('live');
        sample.position = await page.evaluate(position => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          const rect = view.coordsAtPos(position), bounds = view.scrollDOM.getBoundingClientRect();
          return { exactSelection: view.state.selection.main.head === position,
            liveVisible: !!rect && rect.bottom > bounds.top && rect.top < bounds.bottom };
        }, tail.head);
        assert.ok(sample.position.exactSelection, 'Source-to-Live must retain the source selection');
        await switchMode('preview'); await sleep(150); await frames(page);
        sample.position.previewVisible = await page.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!;
          const element = [...doc.querySelectorAll('h2')].find(element => element.textContent === 'LOCATION_TAIL');
          const rect = element?.getBoundingClientRect();
          return !!rect && rect.bottom > 0 && rect.top < frame.clientHeight;
        });
        // Rich blocks can grow relative to Source. The caret need not stay in
        // view when retaining the reading anchor. Compare actual source text,
        // since CodeMirror can refine its estimated height for a long line.
        await switchMode('source'); await frames(page);
        sample.position.returned = await page.evaluate(() => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          const bounds = view.scrollDOM.getBoundingClientRect(), content = view.contentDOM.getBoundingClientRect();
          const reading = view.posAtCoords({ x: Math.max(bounds.left + 50, content.left + 2), y: bounds.top + view.scrollDOM.clientHeight / 3 });
          return { head: view.state.selection.main.head, scroll: view.scrollDOM.scrollTop, reading,
            line: reading === null ? null : view.state.doc.lineAt(reading).number };
        });
        assert.equal(sample.position.returned.head, tail.head);
        assert.ok(tail.reading !== null && sample.position.returned.reading !== null
          && Math.abs(sample.position.returned.line - tail.line!) <= 1
          && (sample.position.returned.line !== tail.line || Math.abs(sample.position.returned.reading - tail.reading) <= 200),
          `returning to Source must retain the reading position: ${JSON.stringify({ tail, returned: sample.position.returned })}`);
        if (round === 0 && strategy === 'auto' && initialMode === 'live' && fixture.kind === 'small-complex') {
          await page.screenshot({ path: path.join(output, 'preview-tail.png') });
        }
        const client = await page.createCDPSession();
        await client.send('Performance.enable');
        const memory = (metrics: any) => Object.fromEntries(metrics.metrics.filter((entry: any) => ['JSHeapUsedSize', 'Nodes', 'Documents'].includes(entry.name)).map((entry: any) => [entry.name, entry.value]));
        sample.memoryBeforeGc = memory(await client.send('Performance.getMetrics'));
        sample.memorySeries = [];
        for (let i = 0; i < 3; i++) {
          await sleep(500); await client.send('HeapProfiler.collectGarbage');
          sample.memorySeries.push(memory(await client.send('Performance.getMetrics')));
        }
        sample.memory = sample.memorySeries.at(-1); await client.detach();
        sample.longTasks = await page.evaluate(() => (window as any).__strategyLongTasks);
        sample.eventTimings = await page.evaluate(() => (window as any).__strategyEvents);
        sample.exactSource = true;
        assert.deepEqual(sample.errors, [], 'editing and switching must not produce browser exceptions');
      } catch (error) { sample.failure = error instanceof Error ? error.stack : String(error); }
      finally {
        if (profiler) {
          const { profile } = await profiler.send('Profiler.stop');
          fs.writeFileSync(path.join(output, `${fixture.kind}-${strategy}-${initialMode}-${round}.cpuprofile`), JSON.stringify(profile));
          await profiler.detach();
        }
        report.samples.push(sample); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ round, fixture: fixture.kind, strategy, initialMode, startup: sample.startup, failure: sample.failure }));
        for (const document of documents.values()) document.dispose(); await context.close();
      }
    }
  }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
console.log('Strategy comparison: ' + path.join(output, 'result.json'));
if (report.samples.some((sample: any) => sample.failure)) process.exitCode = 1;
