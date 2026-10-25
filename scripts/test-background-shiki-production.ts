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
const runner = createBackgroundShiki('/worker.js', {name:'test',type:'dark',colors:theme.colors ?? {},tokenColors:theme.tokenColors ?? theme.settings ?? []}, async (_lang,_code,loaded) => {
  if (loaded.has('javascript')) return []; loaded.add('javascript'); return [javascript];
});
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
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname === '/worker.js'
  ? new Response(Bun.file('webview/dist/shiki-highlight-worker.js')) : new Response('<!doctype html><body>Syntax worker regression</body>', { headers: { 'Content-Type': 'text/html' } }) });
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  await page.goto(server.url.href); await page.addScriptTag({ content: script });
  const source = Array.from({ length: 18000 }, (_, index) => `const row${index} = { text: "content", number: 123 };`).join('\n');
  const wait = async (id: number) => {
    await page.waitForFunction(id => (window as any).jobs[id].done, { timeout: 30000 }, id);
    return page.evaluate(id => (window as any).jobs[id], id);
  };
  const first = await page.evaluate(code => (window as any).startSyntax(code), source), cold = await wait(first);
  assert.ok(cold.exact && cold.partialRows === 128 && cold.first < cold.milliseconds / 2);
  const edited = source.replace('row9000 =', 'renamed9000 =');
  const second = await page.evaluate(code => (window as any).startSyntax(code), edited), warm = await wait(second);
  assert.ok(warm.exact);
  const third = await page.evaluate(({ source, edited }) => (window as any).startSyntax('/*\n' + source, edited), { source, edited });
  const obsolete = await wait(third), latest = await wait(obsolete.next);
  assert.ok(obsolete.cancelled && latest.exact, 'A newer edit stops obsolete work and receives its complete syntax');
  const small = await wait(await page.evaluate(() => (window as any).startSyntax('const small = "普通文档😀";\n')));
  assert.ok(small.exact && small.partialRows === 0, 'An ordinary fence remains one complete result');
  const disposed = await page.evaluate(code => { const id = (window as any).startSyntax(code); (window as any).stopSyntax(); return id; }, source);
  assert.ok((await wait(disposed)).cancelled);
  console.log(JSON.stringify({ cold, warm, obsolete, latest }));
  await page.close();
} catch (error) { primary = error; throw error; }
finally {
  server.stop(true);
  try { if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
