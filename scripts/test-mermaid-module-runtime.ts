import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { buildExportHtmlDocument } from '../src/export/exportHtmlTemplate';

const dist = path.resolve('webview/dist/mermaid');
assert.ok(fs.existsSync(path.join(dist, 'mermaidRuntime.js')), 'Build the production Webview first');
const build = await Bun.build({ entrypoints: ['scripts/test-preview-mermaid-runtime-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const entry = await build.outputs[0]!.text();
let failElkOnce = false;
let delayElkOnce = false;
let failDependencyOnce = false;
let holdRuntimeModuleOnce = false;
let releaseHeldRuntimeModule: (() => void) | null = null;
let markHeldRuntimeModuleRequest: (() => void) | null = null;
const moduleRequests = new Map<string, number>();
const preloadNames: string[] = JSON.parse(fs.readFileSync(path.join(dist, 'preload.json'), 'utf8'));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/entry.js') return new Response(entry, { headers: { 'content-type': 'text/javascript' } });
  if (pathname === '/classic.js') return new Response(Bun.file('webview/dist/mermaid.min.js'));
  if (pathname === '/reference.js') return new Response(Bun.file('node_modules/mermaid/dist/mermaid.min.js'));
  if (pathname.startsWith('/module/') || pathname.startsWith('/mermaid/')) {
    moduleRequests.set(pathname, (moduleRequests.get(pathname) ?? 0) + 1);
    if (pathname.endsWith('/mermaidRuntime.js') && holdRuntimeModuleOnce) {
      holdRuntimeModuleOnce = false;
      markHeldRuntimeModuleRequest?.();
      await new Promise<void>(resolve => { releaseHeldRuntimeModule = resolve; });
      releaseHeldRuntimeModule = null;
    }
    if (pathname.endsWith(`/${preloadNames[1]}`) && failDependencyOnce) {
      failDependencyOnce = false;
      return new Response('Unavailable', { status: 503 });
    }
    if (pathname.endsWith('/elk-worker-source.js') && failElkOnce) {
      failElkOnce = false;
      return new Response('Unavailable', { status: 503 });
    }
    if (pathname.endsWith('/elk-worker-source.js') && delayElkOnce) {
      delayElkOnce = false;
      await new Promise(resolve => setTimeout(resolve, 5_200));
    }
    const file = path.resolve(dist, pathname.replace(/^\/(?:module|mermaid)\//, ''));
    return file.startsWith(dist + path.sep) && fs.existsSync(file)
      ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 });
  }
  return new Response('<!doctype html><html><head><meta charset="UTF-8">'
    + (new URL(request.url).searchParams.has('no-preload') ? '' : '<link rel="modulepreload" href="/module/mermaidRuntime.js">'
    + preloadNames.map(name => `<link rel="preload" as="script" crossorigin="anonymous" href="/module/${name}">`).join(''))
    + '<style>body{font:16px Arial}</style></head>'
    + '<body data-meo-mermaid-src="/classic.js" data-meo-mermaid-module-src="/module/mermaidRuntime.js">'
    + '<div id="source"></div><script src="/entry.js"></script></body></html>', { headers: {
    'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src data:; worker-src blob:"
  } });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const scope = window as any, Native = Worker;
    scope.System = { original: true };
    scope.__layoutWorkers = 0; scope.__layoutJobs = 0;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); scope.__layoutWorkers++; }
      postMessage(message: any, ...rest: any[]) {
        if (message.graph?.id) scope.__layoutJobs++;
        super.postMessage(message, ...rest);
      }
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.url.href);
  await page.waitForFunction(() => (window as any).__loadMermaidRuntime);
  const sourceOnly = await page.evaluate(async () => {
    const scope = window as any;
    scope.__source = scope.__createSharedMermaidEditor({ parent: document.getElementById('source'),
      text: '# Source\n\n```mermaid\nflowchart LR; A-->B\n```', initialMode: 'source' });
    for (let index = 0; index < 4; index++) await new Promise(resolve => requestAnimationFrame(resolve));
    return { initialized: Boolean(scope.mermaid), classic: performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/classic.js')) };
  });
  assert.deepEqual(sourceOnly, { initialized: false, classic: false }, 'Source may prefetch core modules without executing the diagram runtime');
  const loaded = await page.evaluate(async () => {
    const scope = window as any, first = scope.__loadMermaidRuntime(), second = scope.__loadMermaidRuntime();
    const samePending = first === second, [a, b] = await Promise.all([first, second]);
    return { samePending, sameRuntime: a === b && a === scope.mermaid,
      bytes: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/module/'))
        .reduce((sum, entry) => sum + (entry as PerformanceResourceTiming).decodedBodySize, 0) };
  });
  assert.ok(loaded.samePending && loaded.sameRuntime, 'concurrent Live/Preview consumers share one module load and runtime');
  assert.ok(await page.evaluate(async () => {
    let taskRan = false;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { taskRan = true; channel.port1.close(); channel.port2.close(); };
    channel.port2.postMessage(null);
    await (window as any).__meoMermaidSystem.import(new URL('/module/core.js', location.href).href);
    return taskRan;
  }), 'Cached diagram imports must let queued interaction tasks run between rendering stages');
  for (const name of preloadNames) assert.equal(moduleRequests.get(`/module/${name}`), 1,
    `Prefetched ${name} must be reused without a second download`);
  assert.ok(await page.evaluate(() => (window as any).System.original), 'The private diagram loader must preserve an existing System global');
  const allModuleBytes = fs.readdirSync(dist).filter(name => name.endsWith('.js'))
    .reduce((bytes, name) => bytes + fs.statSync(path.join(dist, name)).size, 0);
  assert.ok(loaded.bytes < allModuleBytes / 2,
    'loading core cannot eagerly fetch every diagram engine');
  const samples = ['flowchart LR; A[One]-->B[Two]', 'sequenceDiagram\nAlice->>Bob: Hello',
    'classDiagram\nAnimal <|-- Duck', 'mindmap\n  root((Root))\n    A\n    B',
    '---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A[One]-->B[Two]',
    'stateDiagram-v2\n  [*] --> Ready\n  Ready --> Done',
    'erDiagram\n  READER ||--o{ DOCUMENT : reads', 'pie title Shares\n  "One" : 30\n  "Two" : 70',
    'flowchart LR\n  A["$$x^2 + 1$$"] --> B[Result]',
    'flowchart TB\n  subgraph Outer[Outer title]\n    subgraph Inner[Inner title]\n      A[Start] --> B[Next]\n    end\n    C[Outside] --> A\n  end\n  B --> D[Finish]',
    'flowchart LR\n  A[Start] -->|First label| B[Middle]\n  B -->|Second label| C[Finish]\n  C --> A',
    'stateDiagram-v2\n  state Outer {\n    [*] --> Ready\n    Ready --> Done\n  }\n  Outer --> Finished'];
  const render = async (target: typeof page) => target.evaluate(async samples => {
    const runtime = (window as any).mermaid;
    runtime.initialize({ startOnLoad: false, securityLevel: 'strict', deterministicIds: true, theme: 'default' });
    const result = [];
    for (let index = 0; index < samples.length; index++) {
      const value = await runtime.render('fixture' + index, samples[index]);
      const host = document.createElement('div'); host.innerHTML = value.svg; document.body.append(host);
      const svg = host.querySelector('svg')!;
      result.push({ viewBox: svg.getAttribute('viewBox'), nodes: svg.querySelectorAll('.node,.actor,.classGroup').length });
    }
    return result;
  }, samples);
  const modular = await render(page);
  const layoutWork = await page.evaluate(() => ({ workers: (window as any).__layoutWorkers,
    jobs: (window as any).__layoutJobs, fetched: performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/elk-worker-source.js')) }));
  assert.equal(layoutWork.workers, 1, 'Live/Preview diagram layouts share one real worker instead of creating one engine per graph');
  assert.ok(layoutWork.jobs >= 8 && layoutWork.fetched, 'the default ELK paths must execute through the packaged worker under the production CSP');
  assert.equal(await page.evaluate(async () => (await (window as any).__meoMermaidSystem.import(
    new URL('/module/elk-worker-source.js', location.href).href)).default),
    fs.readFileSync('node_modules/elkjs/lib/elk-worker.min.js', 'utf8'),
    'The lazy module must return the exact official worker source');
  const classic = await browser.newPage();
  await classic.goto(server.url.href);
  await classic.addScriptTag({ url: new URL('reference.js', server.url).href });
  assert.deepEqual(modular, await render(classic), 'official module and classic distributions retain graph geometry and node structure');
  assert.ok(await page.evaluate(() => !performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/classic.js'))));
  await page.evaluate(() => (window as any).__source.destroy());
  const retry = await browser.newPage();
  await retry.goto(server.url.href);
  const retried = await retry.evaluate(async () => {
    const scope = window as any;
    document.body.dataset.meoMermaidModuleSrc = '/module/missing.js';
    let rejected = false;
    try { await scope.__loadMermaidRuntime(); } catch { rejected = true; }
    document.body.dataset.meoMermaidModuleSrc = '/module/mermaidRuntime.js';
    const runtime = await scope.__loadMermaidRuntime();
    return rejected && typeof runtime.render === 'function';
  });
  assert.ok(retried, 'a failed module URL cannot poison a later valid runtime request');
  const uncancelledRuntimeLoad = await browser.newPage();
  try {
    await uncancelledRuntimeLoad.goto(new URL('?no-preload', server.url).href);
    let heldRuntimeRequest!: () => void;
    const runtimeRequestStarted = new Promise<void>(resolve => { heldRuntimeRequest = resolve; });
    holdRuntimeModuleOnce = true;
    markHeldRuntimeModuleRequest = heldRuntimeRequest;
    await uncancelledRuntimeLoad.evaluate(() => {
      const scope = window as any;
      scope.__cancelledMermaidRuntimeController = new AbortController();
      scope.__cancelledMermaidRuntimeLoad = scope.__loadMermaidRuntime(
        scope.__cancelledMermaidRuntimeController.signal
      );
      scope.__sharedMermaidRuntimeLoad = scope.__loadMermaidRuntime();
    });
    await runtimeRequestStarted;
    assert.equal(await uncancelledRuntimeLoad.evaluate(async () => {
      const scope = window as any;
      scope.__cancelledMermaidRuntimeController.abort();
      return await scope.__cancelledMermaidRuntimeLoad.then(() => false, () => true);
    }), true, 'a cancelled caller must settle without cancelling an ordinary shared runtime caller');
    releaseHeldRuntimeModule?.();
    releaseHeldRuntimeModule = null;
    assert.ok(await uncancelledRuntimeLoad.evaluate(async () =>
      typeof (await (window as any).__sharedMermaidRuntimeLoad).render === 'function'
    ), 'an ordinary shared runtime caller must retain the pending load after another caller aborts');
  } finally {
    markHeldRuntimeModuleRequest = null;
    releaseHeldRuntimeModule?.();
    releaseHeldRuntimeModule = null;
    await uncancelledRuntimeLoad.close();
  }
  const siblingSignalRuntimeLoad = await browser.newPage();
  try {
    await siblingSignalRuntimeLoad.goto(new URL('?no-preload', server.url).href);
    let heldRuntimeRequest!: () => void;
    const runtimeRequestStarted = new Promise<void>(resolve => { heldRuntimeRequest = resolve; });
    holdRuntimeModuleOnce = true;
    markHeldRuntimeModuleRequest = heldRuntimeRequest;
    await siblingSignalRuntimeLoad.evaluate(() => {
      const scope = window as any;
      scope.__firstMermaidRuntimeController = new AbortController();
      scope.__secondMermaidRuntimeController = new AbortController();
      scope.__firstMermaidRuntimeLoad = scope.__loadMermaidRuntime(scope.__firstMermaidRuntimeController.signal);
      scope.__secondMermaidRuntimeLoad = scope.__loadMermaidRuntime(scope.__secondMermaidRuntimeController.signal);
    });
    await runtimeRequestStarted;
    assert.equal(await siblingSignalRuntimeLoad.evaluate(async () => {
      const scope = window as any;
      scope.__firstMermaidRuntimeController.abort();
      return await scope.__firstMermaidRuntimeLoad.then(() => false, () => true);
    }), true, 'one signal waiter may leave a shared runtime load');
    releaseHeldRuntimeModule?.();
    releaseHeldRuntimeModule = null;
    assert.ok(await siblingSignalRuntimeLoad.evaluate(async () =>
      typeof (await (window as any).__secondMermaidRuntimeLoad).render === 'function'
    ), 'a remaining signal waiter must retain the shared runtime load after its sibling aborts');
  } finally {
    markHeldRuntimeModuleRequest = null;
    releaseHeldRuntimeModule?.();
    releaseHeldRuntimeModule = null;
    await siblingSignalRuntimeLoad.close();
  }
  const abandonedRuntimeLoad = await browser.newPage();
  try {
    await abandonedRuntimeLoad.goto(new URL('?no-preload', server.url).href);
    let heldRuntimeRequest!: () => void;
    const runtimeRequestStarted = new Promise<void>(resolve => { heldRuntimeRequest = resolve; });
    holdRuntimeModuleOnce = true;
    markHeldRuntimeModuleRequest = heldRuntimeRequest;
    await abandonedRuntimeLoad.evaluate(() => {
      const scope = window as any;
      scope.__abandonedMermaidRuntimeController = new AbortController();
      scope.__abandonedMermaidRuntimeLoad = scope.__loadMermaidRuntime(
        scope.__abandonedMermaidRuntimeController.signal
      );
    });
    await runtimeRequestStarted;
    const recoveredAfterAbort = await abandonedRuntimeLoad.evaluate(async () => {
      const scope = window as any;
      scope.__abandonedMermaidRuntimeController.abort();
      const abandoned = await scope.__abandonedMermaidRuntimeLoad.then(() => false, () => true);
      const runtime = await scope.__loadMermaidRuntime();
      return abandoned && typeof runtime.render === 'function';
    });
    assert.ok(recoveredAfterAbort,
      'an abandoned module load must release its shared pending identity so a later load can recover');
  } finally {
    markHeldRuntimeModuleRequest = null;
    releaseHeldRuntimeModule?.();
    releaseHeldRuntimeModule = null;
    await abandonedRuntimeLoad.close();
  }
  const classicRetry = await browser.newPage();
  await classicRetry.goto(new URL('?no-preload', server.url).href);
  failDependencyOnce = true;
  assert.ok(await classicRetry.evaluate(async () => {
    const scope = window as any;
    delete document.body.dataset.meoMermaidModuleSrc;
    let failed = false;
    try { await scope.__loadMermaidRuntime(); } catch { failed = true; }
    return failed && typeof (await scope.__loadMermaidRuntime()).render === 'function';
  }), 'Classic loading must recover from a failed nested dependency');
  await classicRetry.close();
  const workerRetry = await browser.newPage();
  await workerRetry.goto(server.url.href);
  failElkOnce = true;
  const recovered = await workerRetry.evaluate(async () => {
    const runtime = await (window as any).__loadMermaidRuntime();
    runtime.initialize({ startOnLoad: false, securityLevel: 'strict' });
    let failed = false;
    try { await runtime.render('unavailable', 'flowchart LR; A-->B'); } catch { failed = true; }
    const retry = await runtime.render('recovered', 'flowchart LR; A-->B');
    return failed && retry.svg.includes('<svg');
  });
  assert.ok(recovered, 'A failed worker module must be evicted so a later request can recover');
  await workerRetry.close();
  const workerTimeout = await browser.newPage();
  workerTimeout.on('pageerror', error => errors.push(String(error)));
  await workerTimeout.goto(server.url.href);
  delayElkOnce = true;
  assert.ok(await workerTimeout.evaluate(async () => {
    const runtime = await (window as any).__loadMermaidRuntime();
    runtime.initialize({ startOnLoad: false, securityLevel: 'strict' });
    let failed = false;
    try { await runtime.render('delayed', 'flowchart LR; A-->B'); } catch { failed = true; }
    const retry = await runtime.render('afterTimeout', 'flowchart LR; A-->B');
    await new Promise(resolve => setTimeout(resolve, 600));
    return failed && retry.svg.includes('<svg');
  }), 'A worker source timeout must recover without late-script errors');
  await workerTimeout.close();
  const offlineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-offline-'));
  try {
    fs.cpSync(dist, path.join(offlineRoot, 'mermaid'), { recursive: true });
    fs.copyFileSync('webview/dist/mermaid.min.js', path.join(offlineRoot, 'mermaid.min.js'));
    fs.writeFileSync(path.join(offlineRoot, 'document.html'), buildExportHtmlDocument({
      title: 'Offline Mermaid', target: 'html', hasMermaid: true, hasMath: false,
      stylesCss: 'body { font: 16px Arial; }',
      bodyHtml: samples.map(sample => `<div class="meo-export-mermaid" data-source-b64="${Buffer.from(sample).toString('base64')}"></div>`).join('\n'),
      mermaidRuntimeSrc: pathToFileURL(path.join(offlineRoot, 'mermaid.min.js')).href
    }));
    const offline = await browser.newPage();
    const network: string[] = [];
    offline.on('pageerror', error => errors.push(String(error)));
    await offline.setRequestInterception(true);
    offline.on('request', request => {
      if (/^https?:/.test(request.url())) { network.push(request.url()); void request.abort(); }
      else void request.continue();
    });
    await offline.goto(pathToFileURL(path.join(offlineRoot, 'document.html')).href);
    await offline.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true);
    assert.deepEqual(await offline.evaluate(() => ({
      error: (window as any).__MEO_EXPORT_ERROR__,
      diagrams: document.querySelectorAll('.meo-export-mermaid.is-rendered').length,
      failed: document.querySelectorAll('.meo-export-mermaid.is-error').length
    })), { error: null, diagrams: samples.length, failed: 0 }, 'Relocated HTML must render every diagram through normal file URLs');
    assert.deepEqual(network, [], 'Offline HTML must not require a server or remote assets');
    await offline.close();
  } finally {
    assert.equal(path.dirname(offlineRoot), os.tmpdir());
    fs.rmSync(offlineRoot, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
  console.log(`Mermaid modules: CSP, Source prefetch without execution, shared load, ${loaded.bytes} core bytes, ${samples.length} graph geometry comparisons including ELK/math, and retry passed`);
} finally { await closeTestBrowser(browser); server.stop(true); }
