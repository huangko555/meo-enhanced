import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import darkPlus from '@shikijs/themes/dark-plus';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-shiki-worker-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const workerFile = Bun.file('webview/dist/shiki-highlight-worker.js');
assert.ok(await workerFile.exists(), 'build:webview must produce the packaged classic worker');
const server = Bun.serve({ port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/bundle.js') return new Response(bundle, { headers: { 'content-type': 'text/javascript' } });
  if (path === '/worker.js') return new Response(workerFile, { headers: { 'content-type': 'text/javascript' } });
  return new Response(`<body ${new URL(request.url).searchParams.has('foreground') ? '' : 'data-meo-shiki-worker-src="/worker.js"'}><script src="/bundle.js"></script></body>`, { headers: {
    'content-type': 'text/html',
    'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src blob:"
  } });
} });
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    const Native = Worker;
    (window as any).workerStats = { created: 0, terminated: 0 };
    (window as any).Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).workerStats.created++; }
      terminate() { (window as any).workerStats.terminated++; super.terminate(); }
    };
  });
  await page.goto(server.url.href);
  const reference = await browser.newPage();
  await reference.goto(server.url.href + '?foreground');
  const fixtures = [
    ['typescript', '/* 跨行 😀\n' + '\n'.repeat(300) + '*/\nconst x = { message: "{}" };\n'],
    ['html', '<script>const value = "{}";</script>\n<style>.a {color:red}</style>'],
    ['vue', '<template><div>😀</div></template>\n<script setup lang="ts">const x = {a:1};</script>'],
    ['markdown', '# Heading\n\n```typescript\nconst x = 1;\n```\n\n<div>HTML</div>\n'],
    ['python', 'value = """\n' + '\n'.repeat(260) + 'end"""\ndef run():\n    return {"text": "{}"}']
  ] as const;
  let checked = 0;
  for (const surface of ['editor', 'preview', 'source'] as const) {
    await page.evaluate(({ theme, surface }) => (window as any).shikiWorkerHarness.start(theme, surface), { theme: darkPlus, surface });
    await reference.evaluate(({ theme, surface }) => (window as any).shikiWorkerHarness.start(theme, surface), { theme: darkPlus, surface });
      for (const [lang] of fixtures) {
        await reference.evaluate(({ lang, surface }) => (window as any).shikiWorkerHarness.request(lang, 'prime', surface), { lang, surface });
        await page.evaluate(({ lang, surface }) => (window as any).shikiWorkerHarness.request(lang, 'prime', surface), { lang, surface });
      }
      for (const [lang, input] of fixtures) for (const code of [input, input.replaceAll('\n', '\r\n'), '', '\n']) {
        const expected = await reference.evaluate(({ lang, code, surface }) => (window as any).shikiWorkerHarness.request(lang, code, surface), { lang, code, surface });
        const actual = await page.evaluate(({ lang, code, surface }) => (window as any).shikiWorkerHarness.request(lang, code, surface), { lang, code, surface });
        assert.ok(isDeepStrictEqual(actual, expected), `${surface}/${lang} must preserve exact token colors, offsets and scope metadata`);
        checked++;
      }
  }
  await reference.evaluate(() => (window as any).shikiWorkerHarness.stop());
  await reference.close();
  await page.evaluate(() => (window as any).shikiWorkerHarness.stop());
  assert.deepEqual(await page.evaluate(() => (window as any).workerStats), { created: 3, terminated: 3 }, 'releasing the last surface consumer must terminate its actual CPU work');
  // A cold grammar plus a large token calculation must let the foreground run.
  const responsiveness = await page.evaluate(async theme => {
    const harness = (window as any).shikiWorkerHarness;
    harness.start(theme, 'editor');
    let beats = 0, gap = 0, last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; beats++; }, 8);
    await harness.request('typescript', ('const value = {number:1, text:"hello"};\n').repeat(6_000), 'editor');
    clearInterval(timer); harness.stop(); return { beats, gap };
  }, darkPlus);
  assert.ok(responsiveness.beats >= 5, 'cold compilation/tokenization must run off the event loop');
  assert.ok(responsiveness.gap < 180, `foreground stalled while the worker ran: ${JSON.stringify(responsiveness)}`);
  const replacement = await page.evaluate(async theme => {
    const harness = (window as any).shikiWorkerHarness;
    harness.start(theme, 'editor');
    const obsolete = ('const previous = {number:1, text:"old"};\n').repeat(8_000);
    harness.requestShikiTokens('typescript', obsolete, 'editor');
    await new Promise(resolve => setTimeout(resolve, 30));
    harness.setShikiTheme({ ...theme, tokenColors: [], colors: { ...theme.colors, 'editor.foreground': '#123456' } }, 'editor');
    const tokens = await harness.request('typescript', 'const current = 1;', 'editor');
    const oldCached = harness.getShikiTokens('typescript', obsolete, 'editor');
    harness.stop();
    return { oldCached, colors: [...new Set(tokens.flat().map((syntaxToken: any) => syntaxToken.color))], stats: (window as any).workerStats };
  }, darkPlus);
  assert.equal(replacement.oldCached, null, 'an obsolete worker must not publish across theme replacement');
  assert.deepEqual(replacement.colors, ['#123456']);
  assert.equal(replacement.stats.created, replacement.stats.terminated, 'theme changes and consumer release must retire every worker');
  assert.deepEqual(errors, []);
  console.log(`Shiki classic worker passed ${checked} token parity cases, consumer disposal, and foreground responsiveness ${JSON.stringify(responsiveness)}`);
} finally { await closeTestBrowser(browser); server.stop(true); }
