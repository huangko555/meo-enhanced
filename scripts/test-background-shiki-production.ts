import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-background-syntax-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, `
import { createBackgroundShiki } from ${JSON.stringify(path.resolve('webview/src/helpers/backgroundShiki.ts'))};
import javascript from ${JSON.stringify(fileURLToPath(import.meta.resolve('@shikijs/langs/javascript')))};
import theme from ${JSON.stringify(fileURLToPath(import.meta.resolve('@shikijs/themes/dark-plus')))};
let current = 0;
const jobs = (window as any).jobs = [];
let grammarGate: Promise<void> | undefined, releaseGrammar: (() => void) | undefined;
const createRunner = () => createBackgroundShiki('/worker.js', {name:'test',type:'dark',colors:theme.colors ?? {},tokenColors:theme.tokenColors ?? theme.settings ?? []}, async (_lang,_code,loaded) => {
  const gate = grammarGate; grammarGate = undefined;
  if (gate) { (window as any).coldGrammarHeld = true; await gate; }
  if (loaded.has('javascript')) return []; loaded.add('javascript'); return [javascript];
});
let runner = createRunner();
(window as any).holdColdGrammar = () => {
  runner.dispose(); runner = createRunner();
  (window as any).coldGrammarHeld = false;
  grammarGate = new Promise(resolve => { releaseGrammar = resolve; });
};
(window as any).releaseColdGrammar = () => releaseGrammar?.();
(window as any).startSyntax = (code: string, superseding?: string) => {
  const id = ++current, started = performance.now();
  const job = jobs[id] = { done:false, first:0, milliseconds:0, partialRows:0, exact:false, cancelled:false, next:0 };
  void runner.request('javascript', code, () => current === id, prefix => {
    if (!job.first) {job.first = performance.now()-started;job.partialRows=prefix.length;
      if(superseding !== undefined) job.next=(window as any).startSyntax(superseding);}
  }).then(lines => {job.milliseconds=performance.now()-started;job.cancelled=lines===null;
    job.exact=lines?.map(line=>line.map(syntax=>syntax.content).join('')).join('\\n')===code;job.done=true;});
  return id;
};
(window as any).stopSyntax = () => runner.dispose();
`);
const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const script = await build.outputs[0]!.text();
let failNextWasm = true, wasmRequests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/worker.js') return new Response(Bun.file('webview/dist/shiki-highlight-worker.js'));
  if (pathname === '/onig.wasm') {
    wasmRequests++;
    if (failNextWasm) { failNextWasm = false; return new Response('Unavailable', { status: 503 }); }
    return new Response(Bun.file('webview/dist/onig.wasm'));
  }
  return new Response('<!doctype html><body>Syntax worker regression</body>', { headers: { 'Content-Type': 'text/html' } });
} });
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const NativeBlob = Blob;
    // VS Code can serve resources to the Webview while a Blob worker cannot
    // fetch those URLs. Keep that host restriction in the browser contract.
    (window as any).Blob = class extends NativeBlob {
      constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
        super(options?.type === 'text/javascript'
          ? ['self.fetch = () => Promise.reject(new Error("Worker resource fetch is unavailable"));\n', ...parts]
          : parts, options);
      }
    };
  });
  await page.goto(server.url.href); await page.addScriptTag({ content: script });
  const source = Array.from({ length: 18000 }, (_, index) => `const row${index} = { text: "content", number: 123 };`).join('\n');
  const wait = async (id: number) => {
    await page.waitForFunction(id => (window as any).jobs[id].done, { timeout: 30000 }, id);
    return page.evaluate(id => (window as any).jobs[id], id);
  };
  const unavailable = await wait(await page.evaluate(() => (window as any).startSyntax('const unavailable = 1;')));
  assert.ok(unavailable.cancelled, 'An unavailable WASM asset must settle the request and retire the failed worker');
  const first = await page.evaluate(code => (window as any).startSyntax(code), source), cold = await wait(first);
  assert.ok(cold.exact && cold.partialRows === 128 && cold.first < cold.milliseconds / 2);
  const edited = source.replace('row9000 =', 'renamed9000 =');
  const second = await page.evaluate(code => (window as any).startSyntax(code), edited), warm = await wait(second);
  assert.ok(warm.exact);
  assert.equal(wasmRequests, 2, 'A recovered worker loads the binary once and retains it for warm edits');
  const third = await page.evaluate(({ source, edited }) => (window as any).startSyntax('/*\n' + source, edited), { source, edited });
  const obsolete = await wait(third), latest = await wait(obsolete.next);
  assert.ok(obsolete.cancelled && latest.exact, 'A newer edit stops obsolete work and receives its complete syntax');
  const small = await wait(await page.evaluate(() => (window as any).startSyntax('const small = "普通文档😀";\n')));
  assert.ok(small.exact && small.partialRows === 0, 'An ordinary fence remains one complete result');
  const disposed = await page.evaluate(code => { const id = (window as any).startSyntax(code); (window as any).stopSyntax(); return id; }, source);
  assert.ok((await wait(disposed)).cancelled);
  const replacementBeforeInit = await page.evaluate(() => {
    (window as any).holdColdGrammar();
    return (window as any).startSyntax('const obsolete = 1;');
  });
  // Let the worker be created while its first grammar load is held. The newer
  // request must still receive the unsent binary, rather than reuse a detached
  // cache or initialize a worker without its first-message engine bytes.
  await page.waitForFunction(() => (window as any).coldGrammarHeld);
  const replacementAfterInit = await page.evaluate(() => {
    const id = (window as any).startSyntax('const accepted = "最新";');
    (window as any).releaseColdGrammar();
    return id;
  });
  assert.ok((await wait(replacementBeforeInit)).cancelled);
  assert.ok((await wait(replacementAfterInit)).exact);
  assert.equal(wasmRequests, 2, 'worker recreation reuses the attached Webview binary cache');
  await page.evaluate(() => (window as any).stopSyntax());
  console.log(JSON.stringify({ cold, warm, obsolete, latest }));
  await page.close();
} catch (error) { primary = error; throw error; }
finally {
  server.stop(true);
  try { if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
