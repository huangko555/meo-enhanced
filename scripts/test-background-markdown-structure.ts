import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { syntaxParsingBuildPlugin } from './test-editor-syntax-parsing-build';

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'observe-foreground-outer-parse', setup(builder) {
    for (const [file, marker, guard] of [
      ['displayMathBlocks', '  const literalRanges = collectMarkdownLiteralRanges(state, tree, scope);', '!scope && excludedRanges.length === 0'],
      ['markdownLiteralRanges', '  const ranges: SourceRange[] = [];', '!scope'],
      ['markdownSyntax', '  const detailsBlocks: DetailsBlockInfo[] = [];', 'tree.length > 100000']
    ]) builder.onLoad({ filter: new RegExp(`webview[\\\\/]src[\\\\/]helpers[\\\\/]${file}\\.ts$`) }, async ({ path }) => {
      const source = await Bun.file(path).text();
      assert.equal(source.split(marker).length, 2);
      return { loader: 'ts', contents: source.replace(marker,
        `  if (state.doc.length > 100000 && (${guard})) ((globalThis as any).__foregroundContextScans ??= []).push('${file}');\n${marker}`) };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]helpers[\\/]footnotes\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const marker = /\): FootnoteDefinition\[\] \{\r?\n  const definitions/;
      assert.equal(source.match(new RegExp(marker.source, 'g'))?.length, 1);
      return { loader: 'ts', contents: source.replace(marker,
        '): FootnoteDefinition[] {\n  if (!scope && state.doc.length > 100000) (globalThis as any).__foregroundFootnoteScans = ((globalThis as any).__foregroundFootnoteScans ?? 0) + 1;\n  const definitions') };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]helpers[\\/]liveRenderedBlocks\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const marker = 'function discoverRenderedBlocks(state: EditorState, tree: Tree): DiscoveredBlock[] {';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'ts', contents: source.replace(marker, marker
        + '\n  if (state.doc.length > 100000) (globalThis as any).__foregroundBlockScans = ((globalThis as any).__foregroundBlockScans ?? 0) + 1;') };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]helpers[\\/]longCodeBlocks\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const marker = 'function collectLongCodeBlockDescriptors(state: EditorState): LongCodeBlockDescriptor[] {';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'ts', contents: source.replace(marker,
        marker + '\n  (globalThis as any).__codeDescriptorScans = ((globalThis as any).__codeDescriptorScans ?? 0) + 1;') };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]helpers[\\/]codeFenceSource\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const marker = 'function discoverCodeFences(state: EditorState, tree: Tree): MarkdownCodeFence[] {';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'ts', contents: source.replace(marker, marker
        + '\n  if (state.doc.length > 100000 && tree.children.length) (globalThis as any).__codeSourceScans = ((globalThis as any).__codeSourceScans ?? 0) + 1;') };
    });
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
  } }, syntaxParsingBuildPlugin()] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const workerBuild = await Bun.build({ entrypoints: ['webview/src/markdownParseWorker.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'observe-worker-context-preparation', setup(builder) {
    builder.onLoad({ filter: /webview[\\/]src[\\/]markdownDocumentContext\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text(), marker = '  const state = EditorState.create({ doc, extensions: EditorState.tabSize.of(tabSize) });';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'ts', contents: source.replace(marker,
        '  (globalThis as any).__contextPreparations = ((globalThis as any).__contextPreparations ?? 0) + 1;\n' + marker) };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]markdownParseWorker\.ts$/ }, async ({ path }) => {
      let source = await Bun.file(path).text();
      for (const kind of ['syntax', 'blocks']) {
        const marker = `self.postMessage({ id: request.id, kind: '${kind}',`;
        assert.equal(source.split(marker).length, 2);
        source = source.replace(marker, marker + ' __contextPreparations: (globalThis as any).__contextPreparations,');
      }
      return { loader: 'ts', contents: source };
    });
  } }] });
assert.ok(workerBuild.success, workerBuild.logs.map(String).join('\n'));
const workerBundle = await workerBuild.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/bundle.js') return new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  if (path === '/worker.js') return new Response(workerBundle, { headers: { 'content-type': 'text/javascript' } });
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
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); scope.__workerCreates++;
        this.addEventListener('message', event => {
          if (['syntax', 'blocks'].includes(event.data.kind)) (scope.__workerContextReceipts ??= []).push({ id: event.data.id,
            kind: event.data.kind, prepares: event.data.__contextPreparations, projectedFrom: event.data.projectedFrom,
            hasPayload: event.data.footnotes !== undefined || event.data.code !== undefined || event.data.value !== undefined,
            contextBytes: JSON.stringify([event.data.footnotes, event.data.code, event.data.value]).length });
          if (scope.__corruptProjection === event.data.kind && typeof event.data.projectedFrom === 'number') {
            scope.__corruptProjection = undefined; event.data.projectedFrom = -1;
          }
          if (!scope.__holdParseReplies && !(scope.__holdBlockReplies && event.data.kind === 'blocks')) return;
          event.stopImmediatePropagation();
          (scope.__heldParseReplies ??= []).push({ worker: this, data: event.data });
        });
      }
      postMessage(message: any, ...rest: any[]) {
        scope.__parseRequests.push({ initial: typeof message.text === 'string', units: message.text?.length,
          changesBytes: JSON.stringify(message.changes ?? null).length, base: message.base, id: message.id,
          blocks: message.blocks, tabSize: message.tabSize, changes: message.changes });
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
    const text = 'EDIT\n\n```javascript\nconst nearValue = "near";\n```\n\nNear note[^global] and literal `[^fake]`.\n\n'
      + '**Paragraph** with *formatting* and ordinary words.\n\n'.repeat(9_000)
      + '```javascript\nconst distantValue = "distant";\n```\n\n'
      + '[^global]: formatted **definition**\n\n    continuation\n\n    - Nested item.\n\n      > Nested quote.\n\n      Nested tail.\n\n    ```\n    literal[^fake]\n    ```\n\n[^fake]: Unused\n\n[^other]: A later global definition\n\n'
      + '| A | B |\n| --- | --- |\n| one | two |\n\n<div>HTML block</div>\n\n$$\nx^2\n$$\n\nDOCUMENT-END\n';
    scope.__original = text;
    scope.__editOnInitial = true;
    scope.__editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text, initialMode: 'source' });
  });
  const ready = () => page.waitForFunction(() => (window as any).__liveHistory.markdownReady((window as any).__editor));
  const projectedReceipt = async () => {
    await page.waitForFunction(() => {
      const scope = window as any, request = scope.__parseRequests.at(-1);
      return scope.__workerContextReceipts.some((receipt: any) => receipt.id === request.id
        && receipt.kind === (request.blocks ? 'blocks' : 'syntax'));
    });
    const wire = await page.evaluate(() => {
      const scope = window as any, request = scope.__parseRequests.at(-1);
      return { request, receipts: scope.__workerContextReceipts.filter((receipt: any) => receipt.id === request.id) };
    });
    assert.ok(wire.receipts.length > 0);
    for (const receipt of wire.receipts) {
      assert.equal(receipt.projectedFrom, wire.request.base, 'projection must name the exact worker base revision');
      assert.equal(receipt.hasPayload, false, 'unchanged source facts must not be cloned across the worker boundary again');
      assert.ok(receipt.contextBytes < 32, 'projection receipt has no full fact arrays or formula strings');
    }
  };
  stage = 'initial structure'; await ready();
  assert.ok(await page.evaluate(() => (window as any).__parseRequests.every((request: any) => !request.blocks)),
    'Source-only revisions prepare global notes without preparing Live block presentation');
  assert.ok(await page.evaluate(() => (window as any).__workerContextReceipts.length >= 2));
  assert.equal(await page.evaluate(() => (window as any).__workerContextReceipts.at(-1).prepares), 1,
    'ordinary prose input during initial parsing must project unchanged source facts instead of rediscovering the entire worker context');
  await projectedReceipt();
  await page.evaluate(async () => { await (window as any).__editor.prepareLiveSyntax(() => true); });
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
      return { keywordBefore, keywordAfter: keywords(), rowsBefore, rowsAfter: document.querySelectorAll('.cm-line.meo-src-code-block').length,
        prepares: scope.__workerContextReceipts.at(-1).prepares };
    }, mode);
    if (mode === 'source') {
      assert.ok(continuity.keywordBefore > 0 && continuity.rowsBefore > 0);
      assert.equal(continuity.keywordAfter, continuity.keywordBefore, 'pending background revisions must not clear Source colors');
      assert.equal(continuity.rowsAfter, continuity.rowsBefore, 'pending background revisions must not clear Source code row presentation');
    }
    await ready();
    assert.equal(await page.evaluate(() => (window as any).__workerContextReceipts.at(-1).prepares), continuity.prepares,
      'Source and Live plain typing must retain global source facts in the worker');
    await projectedReceipt();
    assert.ok(await page.evaluate(() => (window as any).__editor.getText().startsWith('EDITbackground中文')));
    const note = await page.evaluate(() => {
      const scope = window as any, text = scope.__editor.getText();
      return { parsed: scope.__liveHistory.footnotes(scope.__editor), referenceFrom: text.indexOf('[^global]'),
        definitionFrom: text.indexOf('[^global]:') };
    });
    assert.deepEqual(note.parsed.numbers, [['global', 1]]);
    assert.equal(note.parsed.references.length, 1, 'inline and fenced code cannot become references');
    assert.equal(note.parsed.references[0].from, note.referenceFrom);
    assert.equal(note.parsed.references[0].definitionFrom, note.definitionFrom);
    await page.keyboard.down('Control');
    try { await page.keyboard.press('z'); } finally { await page.keyboard.up('Control'); }
    stage = mode + ' undo';
    await ready();
    assert.ok(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__before), 'native browser undo restores exact source');
  }
  stage = 'formatted paragraph projection';
  const formatted = await page.evaluate(() => {
    const scope = window as any;
    scope.__beforeFormatted = scope.__editor.getText();
    const prepares = scope.__workerContextReceipts.at(-1).prepares;
    scope.__liveHistory.input(scope.__editor, scope.__beforeFormatted.indexOf('Paragraph') + 3, '格式');
    return prepares;
  });
  await ready();
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.equal(await page.evaluate(() => (window as any).__workerContextReceipts.at(-1).prepares), formatted,
    'words inside inline formatting retain the worker source indexes');
  await projectedReceipt();
  await page.evaluate(async () => { await (window as any).__editor.undo(); });
  await ready();
  assert.equal(await page.evaluate(() => (window as any).__workerContextReceipts.at(-1).prepares), formatted,
    'formatted prose undo also maps the unchanged source indexes');
  await projectedReceipt();
  assert.equal(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__beforeFormatted), true);
  for (const mode of ['source', 'live'] as const) for (const target of ['definition', 'continuation', 'Nested tail.']) {
    stage = `${mode} footnote-body projection: ${target}`;
    const prepares = await page.evaluate(async ({ mode, target }) => {
      const scope = window as any;
      if (mode === 'live') await scope.__editor.prepareLiveSyntax(() => true);
      await scope.__editor.setMode(mode);
      scope.__beforeFootnote = scope.__editor.getText();
      const prepares = scope.__workerContextReceipts.at(-1).prepares;
      scope.__liveHistory.input(scope.__editor, scope.__beforeFootnote.indexOf(target) + 3, '中文');
      return prepares;
    }, { mode, target });
    await ready();
    await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
    await projectedReceipt();
    assert.equal(await page.evaluate(() => (window as any).__workerContextReceipts.at(-1).prepares), prepares,
      'plain footnote-body input must not rediscover global source facts');
    assert.deepEqual(await page.evaluate(() => (window as any).__liveHistory.footnotes((window as any).__editor).numbers), [['global', 1]]);
    await page.evaluate(async () => { await (window as any).__editor.undo(); });
    await ready(); await projectedReceipt();
    assert.equal(await page.evaluate(() => (window as any).__workerContextReceipts.at(-1).prepares), prepares,
      'footnote-body undo also uses a base-revision receipt');
    assert.ok(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__beforeFootnote));
  }
  stage = 'published revision gates derived refresh';
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  await page.evaluate(() => {
    const scope = window as any;
    scope.__beforeDelayed = scope.__editor.getText();
    scope.__editor.view.dispatch({ selection: { anchor: 4 } });
    scope.__editor.view.focus(); scope.__holdParseReplies = true;
    scope.__meoSyntaxParseCalls = [];
  });
  await page.keyboard.type('nativepace', { delay: 40 });
  await new Promise(resolve => setTimeout(resolve, 650));
  const held = await page.evaluate(() => {
    const scope = window as any;
    return { replies: scope.__heldParseReplies?.length ?? 0, pending: scope.__liveHistory.pending(scope.__editor),
      published: scope.__liveHistory.markdownReady(scope.__editor), exact: scope.__editor.getText() === 'EDITnativepace' + scope.__beforeDelayed.slice(4),
      blockingParses: scope.__meoSyntaxParseCalls.filter((call: any) => call.timeout > 8) };
  });
  assert.ok(held.replies > 0 && held.exact && !held.published);
  assert.deepEqual(held.blockingParses, [], 'native input must not synchronously wait for pending background Markdown or unrelated embedded grammars');
  assert.ok(held.pending, 'Live must not commit a full presentation refresh against the pending outer placeholder');
  await page.evaluate(() => {
    const scope = window as any; scope.__holdParseReplies = false;
    for (const { worker, data } of scope.__heldParseReplies.splice(0)) worker.dispatchEvent(new MessageEvent('message', { data }));
  });
  await ready();
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  await page.keyboard.down('Control');
  try { await page.keyboard.press('z'); } finally { await page.keyboard.up('Control'); }
  await ready();
  assert.ok(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__beforeDelayed), 'paced input retains exact single-group undo after worker publication');
  assert.equal(await page.evaluate(() => (window as any).__foregroundLargeMarkdownAdvances ?? 0), 0,
    'Source, Live, input and undo must never parse the entire Markdown on the foreground thread');
  stage = 'syntax publishes before rich block context';
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  await page.evaluate(() => {
    const scope = window as any;
    scope.__holdBlockReplies = true;
    scope.__liveHistory.input(scope.__editor, 4, 'staged');
  });
  await ready();
  await page.waitForFunction(() => (window as any).__heldParseReplies?.length);
  await page.evaluate(() => (window as any).__editor.view.dispatch({ selection: { anchor: 8 } }));
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.ok(await page.evaluate(() => {
    const scope = window as any;
    return scope.__liveHistory.pending(scope.__editor) && scope.__liveHistory.markdownReady(scope.__editor)
      && scope.__liveHistory.footnotes(scope.__editor).numbers[0][1] === 1;
  }), 'published syntax and notes cannot release a Live refresh before the matching rich index arrives');
  await page.evaluate(() => {
    const scope = window as any; scope.__holdBlockReplies = false;
    for (const { worker, data } of scope.__heldParseReplies.splice(0)) worker.dispatchEvent(new MessageEvent('message', { data }));
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  stage = 'changed global footnote context';
  await page.evaluate(() => {
    const scope = window as any;
    scope.__beforeNewReference = scope.__editor.getText();
    scope.__liveHistory.input(scope.__editor, 4, '[^other]', Date.now() + 1_000);
  });
  await ready();
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.deepEqual(await page.evaluate(() => (window as any).__liveHistory.footnotes((window as any).__editor).numbers),
    [['other', 1], ['global', 2]], 'adding a reference updates global numbering beyond the viewport');
  await page.evaluate(async () => { await (window as any).__editor.undo(); });
  await ready();
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.ok(await page.evaluate(() => (window as any).__editor.getText() === (window as any).__beforeNewReference));
  assert.ok(await page.evaluate(() => document.querySelector('.meo-md-footnote-ref')?.getAttribute('aria-label') === 'Jump to footnote 1'),
    'settled undo must restore the visible global reference number as well as source bytes');
  assert.deepEqual(await page.evaluate(() => ({ notes: (window as any).__foregroundFootnoteScans ?? 0,
    blocks: (window as any).__foregroundBlockScans ?? 0 })), { notes: 0, blocks: 0 },
  'entry, input, undo and syntax publication must reuse worker context without foreground global discovery');
  assert.deepEqual(await page.evaluate(() => (window as any).__foregroundContextScans ?? []), [],
    'global formula, literal and details source facts must also come from the worker');
  assert.equal(await page.evaluate(() => (window as any).__codeSourceScans ?? 0), 0,
    'Source and Live must not walk the entire published tree to rediscover code fences');
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
    scope.__outerIdentity = scope.__liveHistory.markdownIdentity(scope.__editor);
    scope.__codeScansBefore = scope.__codeDescriptorScans;
    scope.__editor.scrollToLine(scope.__editor.view.state.doc.lineAt(scope.__editor.getText().indexOf('const distantValue')).number, 'center');
  });
  stage = 'distant code palette';
  await page.waitForFunction(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(node => node.textContent?.includes('const distantValue'));
    const keyword = line && [...line.querySelectorAll('span')].find(node => node.textContent === 'const');
    return keyword && getComputedStyle(keyword).color === (window as any).__keywordColor;
  });
  const requests = await page.evaluate(() => (window as any).__parseRequests);
  assert.ok(await page.evaluate(() => (window as any).__outerIdentity === (window as any).__liveHistory.markdownIdentity((window as any).__editor)),
    'real mixed-language publication must retain the outer Markdown identity');
  assert.ok(await page.evaluate(() => (window as any).__codeScansBefore === (window as any).__codeDescriptorScans),
    'distant code-language publication must not rediscover all code descriptors');
  assert.equal(requests.filter((request: any) => request.initial).length, 1, 'send one initial full snapshot');
  assert.ok(requests.some((request: any) => request.blocks && JSON.stringify(request.changes) === `[${requests[0].units}]`),
    'same-document Live preparation reuses the worker replica and syntax with an empty edit');
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

  for (const part of ['syntax', 'blocks']) {
    stage = 'reject mismatched ' + part + ' projection base';
    const invalid = await page.evaluate(async part => {
      const scope = window as any;
      const editor = scope.__liveHistory.create({ parent: document.getElementById('editor'), text: scope.__original, initialMode: 'source' });
      await editor.prepareLiveSyntax(() => true); await editor.setMode('live');
      scope.__corruptProjection = part;
      scope.__liveHistory.input(editor, 4, 'safe');
      let error = '';
      try { await editor.prepareLiveSyntax(() => true); } catch (reason) { error = String(reason); }
      await editor.setMode('source');
      const exact = editor.getText() === 'EDITsafe' + scope.__original.slice(4);
      editor.destroy(); return { error, exact, consumed: scope.__corruptProjection === undefined };
    }, part);
    assert.ok(invalid.consumed && invalid.exact, 'a rejected receipt must retain the exact editable source');
    assert.match(invalid.error, /Invalid Markdown (source projection base|block context)/);
  }

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
  console.log(`Background Markdown: CSP worker, no foreground full parse, ${requests.length} jobs/one snapshot, receipt-only prose updates, strict projection bases, CJK input, undo, modes, distant code palette, ${incrementalCodeSteps} incremental code LR steps, disposal and failure passed`);
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
