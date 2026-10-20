import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'observe-foreground-outer-parse', setup(builder) {
    builder.onLoad({ filter: /node_modules[\\/]@lezer[\\/]lr[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text(), marker = '    advanceStack(stack, stacks, split) {';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'js', contents: source.replace(marker,
        marker + '\nif(this.stream.input.length>100000)globalThis.__largeCodeSteps=(globalThis.__largeCodeSteps??0)+1;') };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]editor[\\/]backgroundMarkdownStructure\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const marker = '  if (!result.tree || !backend.canPublish(context.state.doc)) return ParseContext.getSkippingParser(result.ready).startParse(input, fragments, ranges);';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'ts', contents: source.replace(marker,
        '  if (!result.tree || !backend.canPublish(context.state.doc)) { (globalThis as any).__backgroundWaiterStarts = ((globalThis as any).__backgroundWaiterStarts ?? 0) + 1; return ParseContext.getSkippingParser(result.ready).startParse(input, fragments, ranges); }') };
    });
    builder.onLoad({ filter: /node_modules[\\/]@lezer[\\/]markdown[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text(), marker = '    advance() {';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'js', contents: source.replace(marker, marker + '\n'
        + 'if(this.input.length>100000&&this.ranges[0].from===0&&this.ranges.at(-1).to===this.input.length)'
        + 'globalThis.__foregroundLargeMarkdownAdvances=(globalThis.__foregroundLargeMarkdownAdvances??0)+1;') };
    });
  } }] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/bundle.js') return new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  if (path === '/worker.js') return new Response(Bun.file('webview/dist/markdown-parse-worker.js'), { headers: { 'content-type': 'text/javascript' } });
  if (path === '/bad-worker.js') return new Response('throw new Error("deliberate parser fixture failure")', { headers: { 'content-type': 'text/javascript' } });
  if (path === '/styles.css') return new Response(Bun.file('webview/src/styles.css'), { headers: { 'content-type': 'text/css' } });
  return new Response('<link rel="stylesheet" href="/styles.css"><style>html,body,#editor{height:100%;margin:0}</style>'
    + '<body data-meo-markdown-worker-src="/worker.js"><div id="editor"></div><script src="/bundle.js"></script></body>', { headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src blob:"
  } });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
let stage = 'startup';
let activePage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
const browserErrors: string[] = [];
try {
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  activePage = page;
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  page.on('pageerror', error => browserErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text().slice(0, 1_000)); });
  await page.evaluateOnNewDocument(() => {
    const scope = window as any, Native = Worker;
    scope.__parseRequests = []; scope.__workerCreates = 0; scope.__workerStops = 0;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); scope.__workerCreates++; }
      postMessage(message: any, ...rest: any[]) {
        scope.__parseRequests.push({ initial: typeof message.text === 'string', units: message.text?.length,
          changesBytes: JSON.stringify(message.changes ?? null).length, base: message.base, id: message.id });
        super.postMessage(message, ...rest);
        if (typeof message.text === 'string' && scope.__editOnInitial) {
          scope.__editOnInitial = false;
          queueMicrotask(() => {
            scope.__liveHistory.input(scope.__editor, 4, 'pre');
            scope.__editor.view.focus(); scope.__editedDuringInitial = true;
          });
        }
      }
      terminate() { scope.__workerStops++; super.terminate(); }
    };
  });
  await page.goto(server.url.href);
  await page.waitForFunction(() => (window as any).__liveHistory);
  await page.evaluate(() => {
    const api = (window as any).__liveHistory;
    const editor = api.create({ parent: document.getElementById('editor'), text: '# Small\n\nordinary', initialMode: 'source' });
    editor.destroy();
  });
  assert.equal(await page.evaluate(() => (window as any).__workerCreates), 0, 'ordinary documents keep their original parser');
  await page.evaluate(() => {
    const scope = window as any;
    const text = 'EDIT\n\n```javascript\nconst nearValue = "near";\n```\n\n'
      + '**Paragraph** with *formatting* and ordinary words.\n\n'.repeat(9_000)
      + '```javascript\nconst distantValue = "distant";\n```\n\nDOCUMENT-END\n';
    scope.__original = text;
    scope.__editOnInitial = true;
    scope.__editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text, initialMode: 'source' });
    scope.__initialPreparation = scope.__editor.prepareLiveSyntax(() => true);
  });
  const ready = () => page.waitForFunction(() => (window as any).__liveHistory.markdownReady((window as any).__editor));
  stage = 'initial structure'; await ready();
  assert.ok(await page.evaluate(() => (window as any).__initialPreparation));
  assert.ok(await page.evaluate(() => (window as any).__backgroundWaiterStarts < 100), 'background preparation cannot busy-poll the placeholder parser');
  assert.ok(await page.evaluate(() => (window as any).__editedDuringInitial
    && (window as any).__editor.getText().startsWith('EDITpre')), 'input during the initial worker request reaches the latest revision');
  await page.keyboard.down('Control');
  try { await page.keyboard.press('z'); } finally { await page.keyboard.up('Control'); }
  await ready();
  assert.ok(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__original));
  for (const mode of ['source', 'live'] as const) {
    stage = mode + ' input';
    const continuity = await page.evaluate(async mode => {
      const scope = window as any;
      await scope.__editor.prepareLiveSyntax(() => true);
      await scope.__editor.setMode(mode);
      scope.__before = scope.__editor.getText();
      scope.__editor.view.dispatch({ selection: { anchor: 4 } });
      scope.__editor.view.focus();
      const keywords = () => [...document.querySelectorAll('.cm-line span')].filter(node => node.textContent === 'const').length;
      const keywordBefore = keywords(), rowsBefore = document.querySelectorAll('.cm-line.meo-src-code-block').length;
      for (const character of 'background中文') scope.__liveHistory.input(scope.__editor, scope.__editor.view.state.selection.main.head, character);
      return { keywordBefore, keywordAfter: keywords(), rowsBefore, rowsAfter: document.querySelectorAll('.cm-line.meo-src-code-block').length };
    }, mode);
    if (mode === 'source') {
      assert.ok(continuity.keywordBefore > 0 && continuity.rowsBefore > 0);
      assert.equal(continuity.keywordAfter, continuity.keywordBefore, 'pending background revisions must not clear Source colors');
      assert.equal(continuity.rowsAfter, continuity.rowsBefore, 'pending background revisions must not clear Source code row presentation');
    }
    await ready();
    assert.ok(await page.evaluate(() => (window as any).__editor.getText().startsWith('EDITbackground中文')));
    await page.keyboard.down('Control');
    try { await page.keyboard.press('z'); } finally { await page.keyboard.up('Control'); }
    stage = mode + ' undo';
    await ready();
    assert.ok(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__before), 'native browser undo restores exact source');
  }
  assert.equal(await page.evaluate(() => (window as any).__foregroundLargeMarkdownAdvances ?? 0), 0,
    'Source, Live, input and undo must never parse the entire Markdown on the foreground thread');
  stage = 'near code palette';
  await page.evaluate(async () => {
    const scope = window as any;
    await scope.__editor.setMode('source');
    scope.__editor.scrollToLine(4, 'center');
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-line span')].some(node => node.textContent === 'const'));
  await page.evaluate(() => {
    const scope = window as any;
    const keyword = [...document.querySelectorAll('.cm-line span')].find(node => node.textContent === 'const')!;
    scope.__keywordColor = getComputedStyle(keyword).color;
    scope.__editor.scrollToLine(scope.__editor.view.state.doc.lineAt(scope.__editor.getText().indexOf('const distantValue')).number, 'center');
  });
  stage = 'distant code palette';
  await page.waitForFunction(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(node => node.textContent?.includes('const distantValue'));
    const keyword = line && [...line.querySelectorAll('span')].find(node => node.textContent === 'const');
    return keyword && getComputedStyle(keyword).color === (window as any).__keywordColor;
  });
  const requests = await page.evaluate(() => (window as any).__parseRequests);
  assert.equal(requests.filter((request: any) => request.initial).length, 1, 'send one initial full snapshot');
  assert.ok(requests.length >= 5 && requests.filter((request: any) => !request.initial).every((request: any) => request.changesBytes < 2_000),
    `following jobs transfer composed edits only: ${JSON.stringify(requests)}`);
  await page.evaluate(() => (window as any).__editor.destroy());
  assert.equal(await page.evaluate(() => (window as any).__workerStops), 1, 'destroy retires the owned parser worker');

  stage = 'large code incremental parsing';
  await page.evaluate(() => {
    const scope = window as any;
    const text = '```javascript\n' + Array.from({ length: 9_000 }, (_, index) => `const value${index} = { number: ${index}, text: "sample" };\n`).join('') + '```\n';
    scope.__codeEditor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text, initialMode: 'source' });
  });
  await page.waitForFunction(() => (window as any).__liveHistory.markdownReady((window as any).__codeEditor));
  const codeSteps = await page.evaluate(() => {
    const scope = window as any, editor = scope.__codeEditor;
    const before = scope.__largeCodeSteps ?? 0;
    scope.__liveHistory.input(editor, editor.getText().indexOf('value0') + 5, 'X');
    return before;
  });
  await page.waitForFunction(() => (window as any).__liveHistory.markdownReady((window as any).__codeEditor));
  const incrementalCodeSteps = await page.evaluate(before => (window as any).__largeCodeSteps - before, codeSteps);
  assert.ok(incrementalCodeSteps < 5_000, `a code edit must reuse existing inner-language fragments: ${incrementalCodeSteps} LR steps`);
  await page.evaluate(() => (window as any).__codeEditor.destroy());

  const failure = await page.evaluate(async () => {
    const scope = window as any;
    document.body.dataset.meoMarkdownWorkerSrc = '/bad-worker.js';
    const editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text: scope.__original, initialMode: 'source' });
    let error = '';
    try { await editor.prepareLiveSyntax(() => true); } catch (reason) { error = String(reason); }
    scope.__liveHistory.input(editor, 4, 'safe');
    const textIntact = editor.getText() === 'EDITsafe' + scope.__original.slice(4);
    editor.destroy();
    return { error, textIntact };
  });
  assert.match(failure.error, /deliberate parser fixture failure/);
  assert.ok(failure.textIntact, 'worker failure retains editable Source and exact text');
  assert.equal(await page.evaluate(() => (window as any).__foregroundLargeMarkdownAdvances ?? 0), 0, 'failure cannot fall back to a blocking full parse');
  assert.deepEqual(errors, []);
  console.log(`Background Markdown: CSP worker, no foreground full parse, ${requests.length} jobs/one snapshot, CJK input, undo, modes, distant code palette, ${incrementalCodeSteps} incremental code LR steps, disposal and failure passed`);
} catch (error) {
  console.error(JSON.stringify({ stage, browserErrors, details: await activePage?.evaluate(() => {
    const scope = window as any;
    return { requests: scope.__parseRequests, syntax: scope.__editor && scope.__liveHistory.syntaxInfo(scope.__editor),
      failure: scope.__editor && scope.__liveHistory.parseFailure(scope.__editor), foreground: scope.__foregroundLargeMarkdownAdvances,
      keywordColor: scope.__keywordColor, lines: [...document.querySelectorAll('.cm-line')].slice(0, 8).map(node => node.outerHTML.slice(0, 1_000)),
      embedded: scope.__embeddedRequests, path: scope.__editor && scope.__liveHistory.syntaxPath(scope.__editor, scope.__editor.getText().indexOf('const nearValue')+7) };
  }).catch(String) }));
  throw error;
} finally { await closeTestBrowser(browser); server.stop(true); }
