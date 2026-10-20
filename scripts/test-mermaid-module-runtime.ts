import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const dist = path.resolve('webview/dist/mermaid');
assert.ok(fs.existsSync(path.join(dist, 'mermaidRuntime.js')), 'Build the production Webview first');
const build = await Bun.build({ entrypoints: ['scripts/test-preview-mermaid-runtime-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const entry = await build.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/entry.js') return new Response(entry, { headers: { 'content-type': 'text/javascript' } });
  if (pathname === '/classic.js') return new Response(Bun.file('webview/dist/mermaid.min.js'));
  if (pathname.startsWith('/module/')) {
    const file = path.resolve(dist, pathname.slice('/module/'.length));
    return file.startsWith(dist + path.sep) && fs.existsSync(file)
      ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 });
  }
  return new Response('<!doctype html><html><head><meta charset="UTF-8">'
    + '<link rel="modulepreload" href="/module/mermaidRuntime.js"><style>body{font:16px Arial}</style></head>'
    + '<body data-meo-mermaid-src="/classic.js" data-meo-mermaid-module-src="/module/mermaidRuntime.js">'
    + '<div id="source"></div><script src="/entry.js"></script></body></html>', { headers: {
    'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src data:"
  } });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
try {
  const page = await browser.newPage();
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
  assert.ok(loaded.bytes < fs.statSync('webview/dist/mermaid.min.js').size / 2,
    'loading core cannot eagerly fetch every diagram engine');
  const samples = ['flowchart LR; A[One]-->B[Two]', 'sequenceDiagram\nAlice->>Bob: Hello',
    'classDiagram\nAnimal <|-- Duck', 'mindmap\n  root((Root))\n    A\n    B',
    '---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A[One]-->B[Two]',
    'stateDiagram-v2\n  [*] --> Ready\n  Ready --> Done',
    'erDiagram\n  READER ||--o{ DOCUMENT : reads', 'pie title Shares\n  "One" : 30\n  "Two" : 70',
    'flowchart LR\n  A["$$x^2 + 1$$"] --> B[Result]'];
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
  const classic = await browser.newPage();
  await classic.goto(server.url.href);
  await classic.addScriptTag({ url: new URL('classic.js', server.url).href });
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
  assert.deepEqual(errors, []);
  console.log(`Mermaid modules: CSP, Source prefetch without execution, shared load, ${loaded.bytes} core bytes, ${samples.length} graph geometry comparisons including ELK/math, and retry passed`);
} finally { await closeTestBrowser(browser); server.stop(true); }
