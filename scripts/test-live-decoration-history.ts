import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { installGitDiffWorker } from './git-diff-worker-fixture';

const root = path.resolve(import.meta.dir, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-decoration-history-'));
const build = await Bun.build({ entrypoints: [path.join(root, 'scripts/test-live-decoration-history-entry.ts')],
  target: 'browser', format: 'iife', outdir: directory, naming: 'bundle.js',
  plugins: [{ name: 'count-authoritative-live-builds', setup(builder) {
    builder.onLoad({ filter: /@codemirror[\\/]language[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'newCx.work(20 /* Work.Apply */, upto)';
      assert.equal(source.split(boundary).length, 2);
      assert.equal(source.split('let upto = this.context.treeLen').length, 2);
      assert.equal(source.split('return new LanguageState(newCx);').length, 2);
      return { loader: 'js', contents: source.replace(boundary,
        'newCx.work(20 /* Work.Apply */, globalThis.__liveTestParseEnd ?? upto)')
        .replace('let upto = this.context.treeLen',
          'if (globalThis.__liveTestFreshParse) newCx.fragments = []; let upto = this.context.treeLen')
        .replace('return new LanguageState(newCx);',
          'if (globalThis.__liveTestParseEnd !== undefined) (globalThis.__liveTestLimitedParses ??= []).push({ tree: newCx.tree.length, length: tr.newDoc.length, done: newCx.isDone(tr.newDoc.length) }); return new LanguageState(newCx);') };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]liveMode\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'return buildDecorations(state, fallback, extra.changes);';
      assert.equal(source.split(boundary).length, 2);
      const localBoundary = 'function projectLiveLocalInput(decorations: DecorationSet, transaction: Transaction): DecorationSet | undefined {';
      assert.equal(source.split(localBoundary).length, 2);
      return { loader: 'ts', contents: source.replace(boundary,
        '((globalThis as any).__fullLiveBuilds ??= 0); (globalThis as any).__fullLiveBuilds++; ' +
        '((globalThis as any).__fullLiveBuildStates ??= []).push({ context, complete: markdownStructureAvailable(state) }); ' + boundary)
        .replace(localBoundary, localBoundary + ' ((globalThis as any).__scopedLiveInputs ??= 0); (globalThis as any).__scopedLiveInputs++;') };
    });
    for (const [file, boundary, counter] of [
      ['liveRenderedBlocks', 'function discoverRenderedBlocks(state: EditorState, tree: Tree): DiscoveredBlock[] {', '__renderedDiscoveries'],
      ['math', 'export function renderLatexMathToHtml(content: string, mode: LatexMathMode): string | null {', '__mathFormats'],
      ['gitDiffGutter', 'function buildCoalescedDiffLineFlags(state: EditorState, baseline: BaselineSnapshot | null): (MarkerFlags | undefined)[] | null {', '__diffBuilds']
    ]) builder.onLoad({ filter: new RegExp(`webview[\\\\/]src[\\\\/]helpers[\\\\/]${file}\\.ts$`) }, async ({ path }) => {
      const source = await Bun.file(path).text();
      assert.equal(source.split(boundary).length, 2);
      return { loader: 'ts', contents: source.replace(boundary, `${boundary} ((globalThis as any).${counter} ??= 0); (globalThis as any).${counter}++;`) };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]helpers[\\/]htmlContent\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'export function collectRenderableHtmlBlocks(state: EditorState, tree: Tree = resolvedSyntaxTree(state), scope?: { from: number; to: number }): RenderableHtmlBlock[] {';
      assert.equal(source.split(boundary).length, 2);
      return { loader: 'ts', contents: source.replace(boundary,
        `${boundary} if (!scope) { ((globalThis as any).__fullHtmlRequests ??= 0); (globalThis as any).__fullHtmlRequests++; }`) };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]helpers[\\/]markdownSyntax\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'return ensureSyntaxTree(state, upto, timeout) ?? syntaxTree(state);';
      assert.equal(source.split(boundary).length, 2);
      return { loader: 'ts', contents: source.replace(boundary,
        `const stack = new Error().stack ?? ''; if (stack.includes('buildDecorationRanges')) { ((globalThis as any).__localParseRequests ??= 0); (globalThis as any).__localParseRequests++; } if (stack.includes('projectLiveLocalInput') && stack.includes('parseFootnotes')) { ((globalThis as any).__projectedFootnoteParseRequests ??= 0); (globalThis as any).__projectedFootnoteParseRequests++; } ${boundary}`) };
    });
    builder.onLoad({ filter: /webview[\\/]src[\\/]helpers[\\/]shikiDecorations\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'this.releaseHighlighting = activateShikiCodeHighlighting();';
      return { loader: 'ts', contents: source.replace(boundary,
        `${boundary} (view.dom as any).__canRequestCodeHighlight = this.canHighlight;`) };
    });
  } }] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent('<style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addScriptTag({ path: path.join(directory, 'bundle.js') });
  await installGitDiffWorker(page);
  const windowConstruction = await page.evaluate(async () => {
    const scope = window as any, api = scope.__liveHistory;
    const text = '# First reading window\n\n' + 'Visible prose.\n\n'.repeat(120)
      + Array.from({ length: 300 }, (_, index) => `| Column | Value |\n| --- | --- |\n| Row ${index} | value |\n\n$$\nx_{${index}}^2 + 1\n$$\n\n`).join('');
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'source', onApplyTransaction() {} });
    await editor.prepareLiveSyntax(() => true);
    scope.__mathFormats = 0;
    editor.setMode('live');
    const formats = scope.__mathFormats;
    let geometry = 0;
    for (const cursor = api.decorations(editor).iter(); cursor.value; cursor.next()) {
      if (cursor.value.spec.widget?.constructor.name === 'ViewportWidgetPlaceholder') geometry += 1;
    }
    scope.__mathFormats = 0;
    editor.view.dispatch({ selection: { anchor: 0, head: editor.view.state.doc.length } });
    const selectAllFormats = scope.__mathFormats;
    editor.destroy();
    return { formats, geometry, selectAllFormats };
  });
  assert.ok(windowConstruction.formats < 10, `entering Live must not format 300 distant formulas (${windowConstruction.formats})`);
  assert.equal(windowConstruction.geometry, 600, 'all distant tables/formulas must retain structural geometry without full widgets');
  assert.ok(windowConstruction.selectAllFormats < 10, 'selecting the document must not format every selected formula');
  const coldLargeLive = await page.evaluate(async () => {
    const scope = window as any, api = scope.__liveHistory;
    const text = 'EDIT\n\n' + Array.from({ length: 1_600 }, (_, i) =>
      `## Section ${i}\n\nA paragraph with **formatting** and a [link](https://example.com).\n\n` +
      '```javascript\nconst item = { key: "value", count: 123 };\nconsole.log(item);\n```\n\n' +
      '```markdown\n# Code heading\n\nLiteral **Markdown** code.\n```\n\n' +
      '<section><p>Literal HTML example with <strong>content</strong>.</p></section>\n\n').join('');
    const realNow = Date.now;
    let ticks = realNow(), paintBeforeCommit = false;
    // Model a parser that cannot finish in the current foreground slice.
    // The first real frame restores its normal clock, independently of the
    // implementation used to prepare Live.
    Date.now = () => ticks += 100;
    const editor = api.create({ parent: document.getElementById('editor'), text,
      initialMode: 'source', onApplyChanges() {} });
    const initial = api.syntaxInfo(editor), before = (scope.__fullLiveBuildStates ??= []).length;
    let current = true;
    requestAnimationFrame(() => {
      Date.now = realNow;
      paintBeforeCommit = editor.view.dom.classList.contains('meo-mode-source');
      api.input(editor, 4, 'p');
      current = false;
    });
    try {
      const cancelled = await editor.prepareLiveSyntax?.(() => current);
      const sourceAfterCancellation = editor.view.dom.classList.contains('meo-mode-source');
      await editor.prepareLiveSyntax?.(() => true);
      editor.setMode('live');
      const builds = scope.__fullLiveBuildStates.slice(before);
      const sourceUnchanged = editor.getText() === 'EDITp' + text.slice(4);
      const beforeInput = scope.__fullLiveBuilds;
      api.input(editor, 5, 'x');
      const deadline = performance.now() + 5_000;
      while (api.pending(editor) && performance.now() < deadline) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return { initial, builds, paintBeforeCommit, sourceUnchanged, cancelled, sourceAfterCancellation, pending: api.pending(editor),
        inputText: editor.getText().startsWith('EDITpx'), inputBuilds: scope.__fullLiveBuilds - beforeInput };
    } finally { Date.now = realNow; editor.destroy(); }
  });
  assert.ok(!coldLargeLive.initial.available, 'cold transition must begin with unfinished shared Markdown syntax');
  assert.ok(coldLargeLive.builds.length > 0);
  assert.ok(coldLargeLive.builds.every((build: { complete: boolean }) => build.complete),
    'large Live must build its canonical presentation from complete shared syntax, rather than repair a partial first build later');
  assert.ok(coldLargeLive.paintBeforeCommit, 'Source must get a real frame while large Live syntax is prepared');
  assert.ok(coldLargeLive.sourceUnchanged);
  assert.equal(coldLargeLive.cancelled, false, 'a newer mode intent must cancel incomplete Live syntax preparation');
  assert.ok(coldLargeLive.sourceAfterCancellation, 'cancelling preparation must retain the existing Source surface');
  assert.ok(coldLargeLive.inputText && !coldLargeLive.pending);
  assert.equal(coldLargeLive.inputBuilds, 0, 'first prose input after cold preparation must not repair the whole Live document');
  const partialInputs = await page.evaluate(async () => {
    const scope = window as any, api = scope.__liveHistory;
    const results = [];
    for (const includeTail of [false, true]) {
      const text = (includeTail
        ? 'EDIT\n\nFootnote[^note], distant[^late].\n\n[^note]: Global definition.\n\n'
        : 'EDIT\n\nFootnote[^note].\n\n[^note]: Global definition.\n\n') +
        Array.from({ length: 1_600 }, (_, i) => `## Section ${i}\n\nA **formatted** paragraph.\n\n` +
          '```javascript\nconst item = { value: 123 };\nconsole.log(item);\n```\n\n' +
          '```markdown\n# Literal heading\n\nLiteral **Markdown**.\n```\n\n').join('') + (includeTail
        ? '\n| Distant | Table |\n| --- | --- |\n| Tail | Value |\n\n[^late]: Distant definition.\n' : '');
      const editor = api.create({ parent: document.getElementById('editor'), text,
        initialMode: 'source', onApplyChanges() {} });
      await editor.prepareLiveSyntax(() => true);
      editor.setMode('live');
      const blocksBefore = includeTail ? api.publishedRenderedBlocks(editor).length : 0;
      const before = scope.__fullLiveBuilds ?? 0;
      const scopedBefore = scope.__scopedLiveInputs ?? 0;
      try {
        // Model unfinished distant mixed-language work, with and without reusable
        // parser fragments. All real presentation fields still execute.
        scope.__liveTestParseEnd = 128;
        scope.__liveTestFreshParse = includeTail;
        scope.__liveTestLimitedParses = [];
        api.input(editor, 4, 'x');
        const afterInput = api.syntaxInfo(editor);
        const blocksAfter = includeTail ? api.publishedRenderedBlocks(editor).length : 0;
        api.input(editor, 5, 'y');
        api.input(editor, 6, 'z');
        const mapped = api.mapped(editor);
        delete scope.__liveTestParseEnd;
        delete scope.__liveTestFreshParse;
        api.parse(editor);
        const deadline = performance.now() + 5_000;
        while (api.pending(editor) && performance.now() < deadline) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        results.push({ includeTail, afterInput, limitedParses: scope.__liveTestLimitedParses, mapped, blocksBefore, blocksAfter,
          scoped: (scope.__scopedLiveInputs ?? 0) - scopedBefore,
          pending: api.pending(editor), builds: (scope.__fullLiveBuilds ?? 0) - before,
          exact: editor.getText() === 'EDITxyz' + text.slice(4),
          notes: JSON.stringify(api.footnotes(editor)) === JSON.stringify(api.freshFootnotes(editor)) });
      } finally { delete scope.__liveTestParseEnd; delete scope.__liveTestFreshParse; editor.destroy(); }
    }
    return results;
  });
  for (const partialInput of partialInputs) {
    assert.ok(partialInput.limitedParses.some((parse: { done: boolean }) => !parse.done),
      'partial-input fixture must leave distant syntax unfinished before presentation fields execute');
    assert.equal(partialInput.builds, 0,
      'closed prose input must not rebuild the whole Live document merely because distant syntax is still pending');
    assert.equal(partialInput.scoped, 0, 'unchanged plain prose needs no scoped renderer or global outside-block syntax comparison');
    assert.ok(!partialInput.includeTail || partialInput.blocksBefore > 0 && partialInput.blocksAfter === partialInput.blocksBefore,
      'geometry readers must retain distant rich blocks while the syntax publication is only a prefix');
    assert.ok(partialInput.mapped && !partialInput.pending && partialInput.exact && partialInput.notes);
  }
  const inputBudgets: Array<{ mode: string; pending: boolean; diffs: number; discoveries: number; htmlRequests: number }> = [];
  const syntaxPublication = await page.evaluate(async () => {
    const scope = window as any, api = scope.__liveHistory;
    const text = 'EDIT\n\nReference[^note].\n\n[^note]: Footnote body.\n\n' + '**Distant paragraph**.\n\n'.repeat(4_100);
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    const initial = api.syntaxInfo(editor), before = api.positionSnapshot(editor), builds = scope.__fullLiveBuilds ?? 0;
    await Promise.resolve();
    const published = api.syntaxInfo(editor), after = api.positionSnapshot(editor);
    const result = { initial, published, before, after, builds: (scope.__fullLiveBuilds ?? 0) - builds, text: editor.getText() === text };
    editor.destroy();
    return result;
  });
  assert.ok(syntaxPublication.initial.published < syntaxPublication.initial.length && syntaxPublication.initial.available,
    'publication fixture must begin with internally complete but unpublished Markdown');
  assert.equal(syntaxPublication.published.published, syntaxPublication.published.length,
    'already completed syntax must publish without waiting for a later parser idle receipt');
  assert.equal(syntaxPublication.builds, 0, 'publishing unchanged Markdown must not rebuild the whole Live presentation');
  assert.deepEqual(syntaxPublication.after, syntaxPublication.before, 'publication must retain the exact canonical presentation');
  assert.ok(syntaxPublication.text, 'syntax publication must not change source text');
  const unpublishedSelection = await page.evaluate(() => {
    const scope = window as any, api = scope.__liveHistory;
    const text = '---\ntitle: First selection\naliases: [First, Second]\n---\n\nReference[^note].\n\n[^note]: Footnote body.\n\n'
      + '**Distant paragraph**.\n\n'.repeat(4_100);
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    const syntax = api.syntaxInfo(editor), builds = scope.__fullLiveBuilds ?? 0, parses = scope.__localParseRequests ?? 0;
    editor.view.dispatch({ selection: { anchor: text.indexOf('aliases:') + 10 } });
    const fullBuilds = (scope.__fullLiveBuilds ?? 0) - builds, localParses = (scope.__localParseRequests ?? 0) - parses;
    const selected = api.positionSnapshot(editor);
    editor.refreshDecorations();
    const complete = api.positionSnapshot(editor);
    const visible = editor.view.contentDOM.textContent.includes('aliases:');
    editor.destroy();
    return { syntax, fullBuilds, localParses, selected, complete, visible };
  });
  assert.ok(unpublishedSelection.syntax.published < unpublishedSelection.syntax.length && unpublishedSelection.syntax.available,
    'first-selection fixture must keep a partial published tree while the complete internal parse is ready');
  assert.equal(unpublishedSelection.fullBuilds, 0,
    'the first caret selection must reuse an already completed internal Markdown tree instead of rebuilding the whole document');
  assert.equal(unpublishedSelection.localParses, 0,
    'nested readers in a proven caret update must use one syntax snapshot without advancing embedded parsers');
  assert.deepEqual(unpublishedSelection.selected, unpublishedSelection.complete,
    'an immediate first selection must retain the complete builder\'s exact canonical presentation');
  assert.ok(unpublishedSelection.visible, 'the optimized caret selection must still reveal its actual source line');
  const unpublishedInput = await page.evaluate(() => {
    const scope = window as any, api = scope.__liveHistory;
    const text = 'EDIT\n\n' + '**Distant paragraph**.\n\n'.repeat(4_100);
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    const syntax = api.syntaxInfo(editor), builds = scope.__fullLiveBuilds ?? 0;
    api.input(editor, 4, 'x');
    scope.__unpublishedEditor = editor; scope.__unpublishedBuilds = builds;
    return syntax;
  });
  assert.ok(unpublishedInput.published < unpublishedInput.length && unpublishedInput.available,
    'the fixture must keep a partial published tree while the complete internal parse is already ready');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__unpublishedEditor));
  assert.equal(await page.evaluate(() => ((window as any).__fullLiveBuilds ?? 0) - (window as any).__unpublishedBuilds), 0,
    'an already completed internal Markdown tree must not be mistaken for missing syntax and trigger a delayed full build');
  await page.evaluate(() => (window as any).__unpublishedEditor.destroy());
  await page.evaluate(() => {
    const scope = window as any, api = scope.__liveHistory;
    const text = 'EDIT\n\n' + Array.from({ length: 4_100 }, (_, i) => `**Paragraph ${i}**.\n\n`).join('');
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    api.parse(editor); editor.refreshDecorations();
    scope.__navigationEditor = editor; scope.__navigationBuilds = scope.__fullLiveBuilds ?? 0;
    editor.scrollToLine(1501, 'center');
  });
  await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
  assert.equal(await page.evaluate(() => ((window as any).__fullLiveBuilds ?? 0) - (window as any).__navigationBuilds), 0,
    'explicit line navigation must update selected blocks without invalidating the whole Live document');
  assert.equal(await page.evaluate(() => {
    const view = (window as any).__navigationEditor.view;
    return view.scrollDOM.scrollTop > 0 && view.contentDOM.textContent.includes('Paragraph 749');
  }), true, 'the optimized navigation must still display its actual target paragraph');
  assert.equal(await page.evaluate(() => (window as any).__liveHistory.scrollOnly((window as any).__navigationEditor)), true,
    'a geometry-only scroll request must retain the accepted canonical presentation');
  const navigated = await page.evaluate(() => (window as any).__liveHistory.positionSnapshot((window as any).__navigationEditor));
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any; scope.__navigationEditor.refreshDecorations();
    return scope.__liveHistory.positionSnapshot(scope.__navigationEditor);
  }), navigated, 'line navigation must preserve the same selected-block presentation as a complete build');
  await page.evaluate(() => (window as any).__navigationEditor.destroy());
  for (const mode of ['source', 'live']) {
    const budget = await page.evaluate(async mode => {
      const scope = window as any, api = scope.__liveHistory;
      const text = 'EDIT\n\n| Name | Value |\n| --- | --- |\n| item | 1 |\n\n' + '**Formatted paragraph**.\n\n'.repeat(4_100);
      const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: mode, initialGitGutter: true, onApplyChanges() {} });
      api.parse(editor); editor.refreshDecorations();
      editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit', baseText: text });
      if (scope.__diffBuilds === undefined || (mode === 'live' && scope.__renderedDiscoveries === undefined)) throw Error('Derived-work counters were not installed');
      scope.__budgetEditor = editor;
      const diffs = scope.__diffBuilds ?? 0, discoveries = scope.__renderedDiscoveries ?? 0;
      scope.__budgetDiscoveries = discoveries;
      const htmlRequests = scope.__fullHtmlRequests ?? 0;
      editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
      api.input(editor, 4, 'x');
      if (!editor.getText().startsWith('EDITx')) throw Error('Primary input must commit before derived work');
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { mode, pending: api.pending(editor), diffs: (scope.__diffBuilds ?? 0) - diffs,
        discoveries: (scope.__renderedDiscoveries ?? 0) - discoveries, htmlRequests: (scope.__fullHtmlRequests ?? 0) - htmlRequests };
    }, mode);
    inputBudgets.push(budget);
    await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__budgetEditor));
    await page.waitForFunction(() => (window as any).__liveHistory.gitSummary((window as any).__budgetEditor).status === 'ready');
    const summary = await page.evaluate(() => (window as any).__liveHistory.gitSummary((window as any).__budgetEditor));
    assert.equal(summary.status, 'ready');
    assert.equal(summary.added, 1, 'settled input must publish the real changed line');
    if (mode === 'live') assert.equal(await page.evaluate(() =>
      ((window as any).__renderedDiscoveries ?? 0) - (window as any).__budgetDiscoveries), 0,
    'settled plain input must reuse its unchanged rendered-block index while still updating real Git differences');
    await page.evaluate(() => (window as any).__budgetEditor.destroy());
  }
  await page.evaluate(async () => {
    const scope = window as any, api = scope.__liveHistory;
    const text = 'EDIT\n\n| Name | Value |\n| --- | --- |\n| *item* | 1 |\n\n' + '**Distant paragraph**.\n\n'.repeat(4_100);
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', initialGitGutter: true, onApplyChanges() {} });
    api.parse(editor); editor.refreshDecorations();
    editor.setGitBaseline({ available: true, tracked: false, headOid: null, mode: 'current-edit', baseText: null });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const previews = [...editor.view.dom.querySelectorAll('.meo-md-html-table-cell-preview')] as HTMLElement[];
    const nodes = previews.map(preview => preview.firstChild);
    const mappings = previews.flatMap(preview => [...preview.querySelectorAll('[data-meo-source-from][data-meo-source-to]')])
      .map(element => ({ element, from: Number(element.getAttribute('data-meo-source-from')), to: Number(element.getAttribute('data-meo-source-to')) }));
    if (!previews.length || !mappings.length) throw Error('The table projection fixture must contain real mapped cell previews');
    const inputs = [...editor.view.dom.querySelectorAll('textarea[data-table-row][data-table-col]')].map((input: HTMLTextAreaElement) => ({
      input, ...api.tableCellSourceRange(editor.view, input)
    }));
    scope.__tableProjection = { editor, previews, nodes, mappings, inputs };
    api.input(editor, 4, 'x');
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__tableProjection.editor));
  const wordTableProjection = await page.evaluate(() => {
    const { editor, previews, nodes, mappings, inputs } = (window as any).__tableProjection;
    return { retained: previews.every((preview: HTMLElement, index: number) => preview.firstChild === nodes[index]),
      mapped: mappings.every(({ element, from, to }: any) => Number(element.getAttribute('data-meo-source-from')) === from
        && Number(element.getAttribute('data-meo-source-to')) === to)
        && inputs.every(({ input, from, to }: any) => { const range = (window as any).__liveHistory.tableCellSourceRange(editor.view, input); return range?.from === from + 1 && range?.to === to + 1; }) };
  });
  assert.deepEqual(wordTableProjection, { retained: true, mapped: true },
    'unchanged table cells must retain relative inline caret mappings while updating absolute cell bounds after earlier prose input');
  await page.evaluate(() => {
    const scope = window as any;
    scope.__liveHistory.input(scope.__tableProjection.editor, 5, '\n', Date.now() + 10_000);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__tableProjection.editor));
  const newlineTableProjection = await page.evaluate(() => {
    const { editor, previews, nodes, mappings, inputs } = (window as any).__tableProjection;
    const result = { retained: previews.every((preview: HTMLElement, index: number) => preview.firstChild === nodes[index]),
      mapped: mappings.every(({ element, from, to }: any) => Number(element.getAttribute('data-meo-source-from')) === from
        && Number(element.getAttribute('data-meo-source-to')) === to)
        && inputs.every(({ input, from, to }: any) => { const range = (window as any).__liveHistory.tableCellSourceRange(editor.view, input); return range?.from === from + 2 && range?.to === to + 2; }) };
    return result;
  });
  assert.deepEqual(newlineTableProjection, { retained: true, mapped: true },
    'moving unchanged Git line flags must retain cell previews and their relative caret mappings');
  await page.evaluate(() => {
    const scope = window as any, { editor } = scope.__tableProjection;
    const input = editor.view.dom.querySelector('textarea[data-table-row="1"][data-table-col="0"]');
    scope.__liveHistory.input(editor, scope.__liveHistory.tableCellSourceRange(editor.view, input).from + 1, 'Z');
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__tableProjection.editor));
  assert.equal(await page.evaluate(() => {
    const { editor } = (window as any).__tableProjection;
    const preview = editor.view.dom.querySelector('textarea[data-table-row="1"][data-table-col="0"]').parentElement.querySelector('.meo-md-html-table-cell-preview');
    const current = preview.textContent.includes('Zitem');
    editor.destroy();
    return current;
  }), true, 'an actual cell text change must still rebuild its preview after metadata-only reuse');
  for (const target of ['EDIT', 'Continued paragraph']) {
    const indexProjection = await page.evaluate(target => {
      const scope = window as any, api = scope.__liveHistory;
      const padding = 'Ordinary padding paragraph.\n\n'.repeat(4_100);
      const text = 'EDIT\n\n' + padding + '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\ngraph LR; A-->B\n```\n\n'
        + '```math\nx^2\n```\n\n<div>Later HTML</div>\n\nReference[^note].\n\n'
        + '[^note]: Definition.\n\n    Continued paragraph.\n\n    <div>Footnote HTML</div>\n';
      const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
      api.parse(editor); editor.refreshDecorations();
      const from = text.indexOf(target) + 2;
      editor.view.dispatch({ selection: { anchor: from } });
      const before = api.renderedBlocks(editor), inputs = [];
      for (let index = 0; index < 3; index++) {
        const discoveries = scope.__renderedDiscoveries ?? 0;
        api.input(editor, from + index, 'x');
        const actual = api.renderedBlocks(editor), scans = (scope.__renderedDiscoveries ?? 0) - discoveries;
        inputs.push({ mapped: api.mapped(editor), scans, actual, expected: api.freshRenderedBlocks(editor) });
      }
      const htmlBefore = api.renderedBlocks(editor).filter((block: any) => block.kind === 'html').length;
      const htmlFrom = editor.getText().indexOf('<div>Later HTML');
      api.editHtml(editor, htmlFrom, htmlFrom + '<div>Later HTML</div>'.length);
      const htmlAfter = api.renderedBlocks(editor).filter((block: any) => block.kind === 'html').length;
      editor.destroy();
      return { before, inputs, htmlBefore, htmlAfter };
    }, target);
    assert.ok(indexProjection.before.some((block: any) => block.kind === 'html'));
    for (const input of indexProjection.inputs) {
      assert.ok(input.mapped, `${target}: exercise certified prose projection`);
      assert.equal(input.scans, 0, `${target}: repeated prose must not rediscover distant rich blocks`);
      assert.deepEqual(input.actual, input.expected, `${target}: mapped discovery must equal an independent full build`);
    }
    assert.equal(indexProjection.htmlAfter, indexProjection.htmlBefore - 1, 'HTML editing must still filter the correctly shifted source anchor');
  }
  const changedFence = await page.evaluate(() => {
    const api = (window as any).__liveHistory;
    const editor = api.create({ parent: document.getElementById('editor'), text: '```js\nx^2\n```\n\nPlain paragraph.', initialMode: 'live', onApplyChanges() {} });
    const before = api.renderedBlocks(editor);
    editor.view.dispatch({ changes: { from: 3, to: 5, insert: 'math' }, selection: { anchor: 7 }, userEvent: 'input.type' });
    const actual = api.renderedBlocks(editor), expected = api.freshRenderedBlocks(editor);
    editor.destroy();
    return { before, actual, expected };
  });
  assert.equal(changedFence.before.some((block: any) => block.kind === 'math'), false);
  assert.ok(changedFence.actual.some((block: any) => block.kind === 'math'), 'changing a fence language must invalidate discovery');
  assert.deepEqual(changedFence.actual, changedFence.expected);
  for (const fence of ['```', '~~~']) {
    const introducedFence = await page.evaluate(fence => {
      const api = (window as any).__liveHistory;
      const text = 'Ordinary padding paragraph.\n\n'.repeat(4_100) + 'EDIT ' + fence + 'mermaid';
      const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
      api.parse(editor); editor.refreshDecorations();
      const before = api.renderedBlocks(editor), from = text.lastIndexOf('EDIT ') + 5;
      editor.view.dispatch({ selection: { anchor: from } });
      api.input(editor, from, '\n');
      const actual = api.renderedBlocks(editor), expected = api.freshRenderedBlocks(editor);
      editor.destroy();
      return { before, actual, expected };
    }, fence);
    assert.equal(introducedFence.before.some((block: any) => block.kind === 'mermaid'), false);
    assert.ok(introducedFence.actual.some((block: any) => block.kind === 'mermaid'), 'a newline can turn literal fence markers into a real rich block');
    assert.deepEqual(introducedFence.actual, introducedFence.expected);
  }
  const nestedParseBudget = await page.evaluate(() => {
    const scope = window as any, api = scope.__liveHistory;
    const text = '# Nested input\n\nReference[^note].\n\n[^note]: Footnote body.\n\n    - First item.\n\n      > Quoted content.\n\n      NESTED_TARGET\n\n      ```js\n      const value = 1;\n      ```\n\n    - Second item.\n\n'
      + '| Name | Value |\n| --- | --- |\n| item | 1 |\n\n$$\nx=1\n$$\n\n<div>Later HTML</div>\n\n'
      + '**Distant paragraph**.\n\n'.repeat(4_100);
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    api.parse(editor); editor.refreshDecorations();
    const from = text.indexOf('NESTED_TARGET') + 'NESTED_TARGET'.length;
    editor.view.dispatch({ selection: { anchor: from } });
    const before = scope.__localParseRequests ?? 0, builds = scope.__fullLiveBuilds ?? 0, scoped = scope.__scopedLiveInputs ?? 0;
    api.input(editor, from, 'x');
    const footnotes = scope.__projectedFootnoteParseRequests ?? 0;
    api.input(editor, from + 1, 'x');
    api.input(editor, from + 2, '，。,.!?');
    scope.__nestedBudgetEditor = editor;
    return { parseRequests: (scope.__localParseRequests ?? 0) - before, builds: (scope.__fullLiveBuilds ?? 0) - builds,
      footnoteParseRequests: (scope.__projectedFootnoteParseRequests ?? 0) - footnotes,
      scopedBuilds: (scope.__scopedLiveInputs ?? 0) - scoped, syntax: api.syntaxInfo(editor) };
  });
  assert.equal(nestedParseBudget.builds, 0, 'nested prose must update its closed block without a full Live build');
  assert.equal(nestedParseBudget.scopedBuilds, 0, `bare nested prose must map stable presentation instead of rebuilding its whole definition on every key (${JSON.stringify(nestedParseBudget.syntax)})`);
  assert.equal(nestedParseBudget.parseRequests, 0, 'a proven local Markdown block must reuse its syntax snapshot instead of repeatedly extending embedded parsers');
  assert.equal(nestedParseBudget.footnoteParseRequests, 0, 'a certified footnote projection must not restart full embedded parsing on each following key');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__nestedBudgetEditor));
  const projectedNested = await page.evaluate(() => (window as any).__liveHistory.positionSnapshot((window as any).__nestedBudgetEditor));
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any; scope.__nestedBudgetEditor.refreshDecorations();
    return scope.__liveHistory.positionSnapshot(scope.__nestedBudgetEditor);
  }), projectedNested, 'the bounded nested block must match a fresh authoritative presentation');
  const newlineBuilds = await page.evaluate(() => {
    const scope = window as any, api = scope.__liveHistory, editor = scope.__nestedBudgetEditor;
    scope.__nestedBeforeEnter = editor.getText();
    api.renderedBlocks(editor);
    scope.__nestedBeforeEnterDiscoveries = scope.__renderedDiscoveries ?? 0;
    const builds = scope.__fullLiveBuilds ?? 0;
    api.input(editor, editor.getText().indexOf('NESTED_TARGETxx') + 'NESTED_TARGETxx'.length, '\n      ', Date.now() + 10_000);
    scope.__nestedBeforeEnterBuilds = builds;
    return (scope.__fullLiveBuilds ?? 0) - builds;
  });
  assert.equal(newlineBuilds, 0, 'a local newline must preserve distant Live presentation on its input frame');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__nestedBudgetEditor));
  assert.equal(await page.evaluate(() => ((window as any).__fullLiveBuilds ?? 0) - (window as any).__nestedBeforeEnterBuilds), 0,
    'settling a newline inside a closed Markdown block must not rebuild the whole document');
  assert.equal(await page.evaluate(() => ((window as any).__renderedDiscoveries ?? 0) - (window as any).__nestedBeforeEnterDiscoveries), 0,
    'a certified plain paragraph newline must map rich-block line coordinates without rediscovering distant blocks');
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any;
    return scope.__liveHistory.renderedBlocks(scope.__nestedBudgetEditor);
  }), await page.evaluate(() => {
    const scope = window as any;
    return scope.__liveHistory.freshRenderedBlocks(scope.__nestedBudgetEditor);
  }), 'mapped newline coordinates must match independent complete discovery');
  const projectedFootnotes = await page.evaluate(() => (window as any).__liveHistory.footnotes((window as any).__nestedBudgetEditor));
  assert.deepEqual(await page.evaluate(() => (window as any).__liveHistory.freshFootnotes((window as any).__nestedBudgetEditor)), projectedFootnotes,
    'a footnote continuation newline must match an independent parse, including new continuation lines and reference targets');
  const newlinePositions = await page.evaluate(() => (window as any).__liveHistory.positionSnapshot((window as any).__nestedBudgetEditor));
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any; scope.__nestedBudgetEditor.refreshDecorations();
    return scope.__liveHistory.positionSnapshot(scope.__nestedBudgetEditor);
  }), newlinePositions, 'a local newline must also rebase later table, math and HTML line identities');
  await page.evaluate(async () => {
    const scope = window as any;
    if (!await scope.__nestedBudgetEditor.undo() || scope.__nestedBudgetEditor.getText() !== scope.__nestedBeforeEnter) throw Error('Local Enter undo must restore exact text');
  });
  await page.evaluate(() => (window as any).__nestedBudgetEditor.destroy());
  await page.evaluate(() => {
    const scope = window as any, api = scope.__liveHistory;
    const text = 'Paragraph\n[ref]: ./reference-image.png\n\nUse ![image][ref].\n\n' + '**Distant paragraph**.\n\n'.repeat(4_100);
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    api.parse(editor); editor.refreshDecorations();
    editor.view.dispatch({ selection: { anchor: 'Paragraph'.length } });
    api.input(editor, 'Paragraph'.length, '\n');
    scope.__referenceBudgetEditor = editor;
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__referenceBudgetEditor));
  const referencePositions = await page.evaluate(() => (window as any).__liveHistory.positionSnapshot((window as any).__referenceBudgetEditor));
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any; scope.__referenceBudgetEditor.refreshDecorations();
    return scope.__liveHistory.positionSnapshot(scope.__referenceBudgetEditor);
  }), referencePositions, 'creating a link definition with Enter must also update references outside the changed block');
  await page.evaluate(() => (window as any).__referenceBudgetEditor.destroy());
  for (const target of ['middle', 'end']) {
    await page.evaluate(target => {
      const scope = window as any, api = scope.__liveHistory;
      const text = 'Plain target paragraph.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n' + '**Distant paragraph**.\n\n'.repeat(4_100);
      const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
      api.parse(editor); editor.refreshDecorations();
      const from = target === 'middle' ? 5 : 'Plain target paragraph.'.length;
      editor.view.dispatch({ selection: { anchor: from } });
      scope.__plainNewlineBuilds = scope.__fullLiveBuilds ?? 0;
      scope.__plainNewlineOriginal = text;
      api.input(editor, from, '\n');
      scope.__plainNewlineEditor = editor;
    }, target);
    await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__plainNewlineEditor));
    assert.equal(await page.evaluate(() => ((window as any).__fullLiveBuilds ?? 0) - (window as any).__plainNewlineBuilds), 0,
      `${target}: plain Enter must not schedule a delayed full-document build`);
    const projected = await page.evaluate(() => (window as any).__liveHistory.positionSnapshot((window as any).__plainNewlineEditor));
    assert.deepEqual(await page.evaluate(() => {
      const scope = window as any; scope.__plainNewlineEditor.refreshDecorations();
      return scope.__liveHistory.positionSnapshot(scope.__plainNewlineEditor);
    }), projected, `${target}: split and trailing blank lines must match complete presentation`);
    await page.evaluate(async () => {
      const scope = window as any;
      if (!await scope.__plainNewlineEditor.undo() || scope.__plainNewlineEditor.getText() !== scope.__plainNewlineOriginal) throw Error('Plain Enter undo must restore exact source');
      scope.__plainNewlineEditor.destroy();
    });
  }
  await page.evaluate(() => {
    const scope = window as any, api = scope.__liveHistory;
    const text = 'EDIT\n\n```js\n' + Array.from({ length: 40 }, (_, index) => `const budget${String(index).padStart(2, '0')} = ${index};`).join('\n')
      + '\n```\n\n' + '**Formatted paragraph**.\n\n'.repeat(4_100);
    scope.__createCodeBudgetEditor = () => {
      scope.__budgetEditor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
      api.parse(scope.__budgetEditor); scope.__budgetEditor.refreshDecorations();
    };
    scope.__createCodeBudgetEditor();
  });
  await page.waitForSelector('.meo-md-long-code-placeholder');
  const prosePoint = await page.evaluate(() => {
    const scope = window as any, view = scope.__budgetEditor.view;
    const line = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.textContent === 'EDIT');
    if (!line) throw Error('The pointer budget requires visible prose');
    const rect = line.getBoundingClientRect();
    view.dom.addEventListener('pointerdown', () => { scope.__clickHighlightReady = view.dom.__canRequestCodeHighlight(); });
    scope.__clickCursorStyles = 0;
    scope.__clickCoordinateReads = 0;
    const coordinates = view.posAtCoords.bind(view);
    view.posAtCoords = (...args: Parameters<typeof coordinates>) => { scope.__clickCoordinateReads++; return coordinates(...args); };
    scope.__cursorObserver = new MutationObserver(records => {
      if (records.some(record => record.oldValue?.includes('meo-pointer-selecting')) || view.dom.classList.contains('meo-pointer-selecting')) scope.__clickCursorStyles++;
    });
    scope.__cursorObserver.observe(view.dom, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    return { x: rect.left + 12, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(prosePoint.x, prosePoint.y);
  assert.equal(await page.evaluate(() => (window as any).__clickHighlightReady), false,
    'a large Live caret click must paint before cold grammar compilation may start');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(() => (window as any).__budgetEditor.view.dom.__canRequestCodeHighlight(),
    { timeout: 5_000 });
  assert.equal(await page.evaluate(() => (window as any).__clickCursorStyles), 0,
    'a caret click must not restyle every descendant with the drag-only cursor override');
  // CodeMirror owns two character hits; toolbar hover may retain one more.
  // Source-line observers must not add their own coordinate measurements.
  assert.ok(await page.evaluate(() => (window as any).__clickCoordinateReads <= 3),
    'source-line observers must use the clicked DOM line instead of repeatedly forcing coordinate measurement');
  await page.mouse.move(prosePoint.x, prosePoint.y);
  await page.mouse.down();
  await page.mouse.move(prosePoint.x + 25, prosePoint.y, { steps: 3 });
  assert.equal(await page.evaluate(() => (window as any).__budgetEditor.view.dom.classList.contains('meo-pointer-selecting')), true,
    'an actual text drag must retain its cursor override');
  await page.mouse.up();
  assert.equal(await page.evaluate(() => (window as any).__budgetEditor.view.dom.classList.contains('meo-pointer-selecting')), false);
  await page.evaluate(() => {
    const scope = window as any;
    scope.__cursorObserver.disconnect();
    scope.__budgetEditor.destroy(); scope.__createCodeBudgetEditor();
  });
  await page.waitForSelector('.meo-md-long-code-placeholder');
  const codePoint = await page.evaluate(() => {
    const line = [...document.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.textContent?.includes('const budget03'));
    if (!line) throw Error('The collapsed code fixture needs a visible source line');
    const rect = line.getBoundingClientRect();
    (window as any).__budgetBuilds = (window as any).__fullLiveBuilds ?? 0;
    return { x: rect.left + 95, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(codePoint.x, codePoint.y);
  const codeBuilds = await page.evaluate(() => ((window as any).__fullLiveBuilds ?? 0) - (window as any).__budgetBuilds);
  await page.evaluate(() => (window as any).__budgetEditor.destroy());
  console.log('Large input derived-work budgets:', { inputBudgets, codeBuilds });
  for (const budget of inputBudgets) {
    assert.equal(budget.pending, true, `${budget.mode}: primary input must own the first frame`);
    assert.equal(budget.diffs, 0, `${budget.mode}: baseline comparisons must wait behind primary input`);
    assert.equal(budget.discoveries, 0, `${budget.mode}: gutter widget painting must not discover the whole document`);
    assert.equal(budget.htmlRequests, 0, `${budget.mode}: a native key guard must only inspect the caret's HTML block`);
  }
  assert.equal(codeBuilds, 0, 'a code folding pointer effect must not rebuild unrelated Live presentation');
  const original = 'EDIT\n\n**Prefix bold**\n\n[local](sample.md)\n\n' + 'Ordinary paragraph.\n\n'.repeat(4_100)
    + '## Distant heading\n\n**Distant bold**\n\n| Name | Value |\n| --- | --- |\n| item | 42 |\n\n$$\nx=1\n$$\n\n<div>HTML body</div>\n\nTAIL';
  await page.evaluate(text => {
    const api = (window as any).__liveHistory;
    const editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    editor.setMode('source');
    editor.setMode('live');
    (window as any).__editor = editor;
  }, original);
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.evaluate(() => {
    const api = (window as any).__liveHistory;
    const editor = (window as any).__editor;
    editor.view.dispatch({ selection: { anchor: 4 } });
    (window as any).__before = api.decorations(editor);
    (window as any).__beforePositions = structuredClone(api.positionSnapshot(editor));
    api.input(editor, 4, 'x');
    editor.setDiagnostics([]);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  const settled = await page.evaluate(() => {
    const scope = window as any;
    const current = scope.__liveHistory.decorations(scope.__editor);
    scope.__after = current;
    scope.__afterPositions = structuredClone(scope.__liveHistory.positionSnapshot(scope.__editor));
    return { before: scope.__before.size, after: current.size, text: scope.__editor.getText() };
  });
  assert.equal(settled.text, original.slice(0, 4) + 'x' + original.slice(4));
  assert.equal(settled.after, settled.before, 'settling input must retain the authoritative offscreen presentation');
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
    assert.equal(await page.evaluate(() => (window as any).__editor.getText()), original);
    assert.equal(await page.evaluate(() => {
      const scope = window as any;
      return JSON.stringify(scope.__liveHistory.positionSnapshot(scope.__editor)) === JSON.stringify(scope.__beforePositions);
    }), true, 'undo must restore complete presentation and current widget positions');
    assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
    assert.equal(await page.evaluate(() => {
      const scope = window as any;
      return JSON.stringify(scope.__liveHistory.positionSnapshot(scope.__editor)) === JSON.stringify(scope.__afterPositions);
    }), true, 'redo must restore complete presentation and current widget positions');
  }
  await page.evaluate(() => {
    const scope = window as any;
    scope.__liveHistory.input(scope.__editor, 5, 'y', Date.now() + 10_000);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    return JSON.stringify(scope.__liveHistory.positionSnapshot(scope.__editor)) === JSON.stringify(scope.__afterPositions);
  }), true, 'a new native history group must restore its own complete presentation');
  assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.scrollToLine(editor.view.state.doc.lines, 'upper');
  });
  await page.waitForSelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea');
  await page.$eval('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea', input => {
    (input as HTMLTextAreaElement).focus();
    (input as HTMLTextAreaElement).value = 'changed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const editedTable = await page.evaluate(() => (window as any).__editor.getText());
  assert.ok(editedTable.includes('| changed | 42 |'), 'a restored distant table must edit its current source');
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  assert.equal(await page.evaluate(() => (window as any).__editor.getText()), original.slice(0, 4) + 'x' + original.slice(4));
  assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
  assert.equal(await page.evaluate(() => (window as any).__editor.getText()), editedTable);

  await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__editor;
    let diagnostic = { from: 1, to: 3, severity: 1, message: 'Example', source: 'test', code: 'example' };
    editor.setDiagnostics([diagnostic]);
    const first = editor.view.state;
    editor.setDiagnostics([{ ...diagnostic }]);
    if (first !== editor.view.state) throw Error('Identical diagnostics must not dispatch a transaction');
    for (const patch of [{ message: 'Changed' }, { severity: 2 }, { source: 'other' }, { code: 'other' }, { from: 0 }, { to: 4 }]) {
      diagnostic = { ...diagnostic, ...patch };
      const previous = editor.view.state;
      editor.setDiagnostics([diagnostic]);
      if (previous === editor.view.state) throw Error('Changed diagnostic data was ignored');
    }
    scope.__liveHistory.input(editor, 0, 'x');
    const mapped = editor.view.state;
    editor.setDiagnostics([diagnostic]);
    if (mapped === editor.view.state) throw Error('Moved diagnostics must accept current host positions');
    const actual = scope.__liveHistory.diagnostics(editor)[0];
    if (actual.from !== diagnostic.from || actual.to !== diagnostic.to) throw Error('Diagnostic positions were not restored');
    editor.setDiagnostics([]);
    const empty = editor.view.state;
    editor.setDiagnostics([]);
    if (empty !== editor.view.state) throw Error('Empty diagnostics must remain a no-op');
  });
  // A plain edit after the last rich block must preserve its geometry on the
  // input frame, and must not rebuild the same full presentation when idle.
  await page.focus('.cm-content');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  const middleInput = await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor, api = scope.__liveHistory;
    scope.__middleBefore = editor.getText();
    const from = editor.getText().indexOf('Ordinary paragraph.') + 'Ordinary paragraph'.length;
    editor.view.dispatch({ selection: { anchor: from } });
    const before = api.decorations(editor).size;
    scope.__middleFullBuilds = scope.__fullLiveBuilds;
    api.input(editor, from, 'x', Date.now() + 10_000);
    scope.__middleProjection = api.decorations(editor);
    scope.__middlePositions = api.positionSnapshot(editor);
    const widgets: Record<string, any> = {};
    for (const cursor = scope.__middleProjection.iter(); cursor.value; cursor.next()) {
      const widget = cursor.value.spec.widget;
      if (widget) widgets[widget.constructor.name] = widget;
    }
    return { before, after: scope.__middleProjection.size,
      tableFrom: widgets.HtmlTableWidget?.tableData.from,
      tableExpected: editor.getText().indexOf('| Name |'),
      mathAnchor: widgets.LatexMathWidget?.anchor,
      mathExpected: editor.getText().indexOf('$$\nx=1\n$$'),
      htmlFrom: widgets.HtmlBlockWidget?.block.from,
      htmlExpected: editor.getText().indexOf('<div>HTML body</div>') };
  });
  assert.equal(middleInput.after, middleInput.before, 'middle input must preserve distant rich block geometry');
  assert.equal(middleInput.tableFrom, middleInput.tableExpected, 'offscreen table data must move with its range');
  assert.equal(middleInput.mathAnchor, middleInput.mathExpected, 'offscreen math controls must move with their range');
  assert.equal(middleInput.htmlFrom, middleInput.htmlExpected, 'offscreen HTML controls must move with their range');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.equal(await page.evaluate(() => (window as any).__middleFullBuilds === (window as any).__fullLiveBuilds),
    true, 'settling input and following the caret may update viewport blocks, but must not rebuild the document');
  await page.evaluate(() => {
    const scope = window as any;
    scope.__middlePositions = structuredClone(scope.__liveHistory.positionSnapshot(scope.__editor));
  });
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any;
    scope.__editor.refreshDecorations();
    return scope.__liveHistory.positionSnapshot(scope.__editor);
  }), await page.evaluate(() => (window as any).__middlePositions),
    'projected widget payloads must match a full authoritative rebuild');
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  await page.waitForFunction(() => (window as any).__editor.getText() === (window as any).__middleBefore);
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__editor;
    const from = editor.getText().indexOf('Ordinary paragraph.') + 2;
    editor.view.dispatch({ selection: { anchor: from } });
    const before = scope.__liveHistory.decorations(editor);
    editor.view.dispatch({ selection: { anchor: from + 1 } });
    return scope.__liveHistory.decorations(editor) === before;
  }), true, 'plain same-line navigation must also preserve later rich blocks whose source positions did not move');
  await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length }, scrollIntoView: true });
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const tail = await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__editor;
    const api = scope.__liveHistory;
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    scope.__tailBefore = api.decorations(editor);
    scope.__tailOriginal = editor.getText();
    scope.__tailFullBuilds = scope.__fullLiveBuilds;
    api.input(editor, editor.view.state.doc.length, 'x', Date.now() + 20_000);
    scope.__tailMapped = api.decorations(editor);
    return { before: scope.__tailBefore.size, after: scope.__tailMapped.size };
  });
  assert.equal(tail.after, tail.before, 'plain tail input must retain distant block geometry on its first frame');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    return scope.__fullLiveBuilds === scope.__tailFullBuilds;
  }), true, 'tail settlement may update viewport blocks but must not rebuild the document');
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    return scope.__editor.getText() === scope.__tailOriginal && scope.__fullLiveBuilds === scope.__tailFullBuilds;
  }), true, 'tail undo must restore exact text without rebuilding the document after viewport updates');
  assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    return scope.__editor.getText() === scope.__tailOriginal + 'x' && scope.__fullLiveBuilds === scope.__tailFullBuilds;
  }), true, 'tail redo must restore exact text without rebuilding the document');
  const tailPositions = await page.evaluate(() => (window as any).__liveHistory.positionSnapshot((window as any).__editor));
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any;
    scope.__editor.refreshDecorations();
    return scope.__liveHistory.positionSnapshot(scope.__editor);
  }), tailPositions, 'tail history and viewport projection must match a complete presentation');
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__editor;
    const before = scope.__liveHistory.decorations(editor);
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length - 1 } });
    const left = scope.__liveHistory.decorations(editor);
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    return left === before && scope.__liveHistory.decorations(editor) === before;
  }), true, 'moving a collapsed caret inside unchanged plain prose must not rebuild distant content');
  for (const mode of ['source', 'live', 'source', 'live']) {
    await page.evaluate(mode => {
      const scope = window as any;
      const editor = scope.__editor;
      const expected = scope.__tailOriginal + 'x';
      const selection = editor.view.state.selection;
      editor.setMode(mode);
      if (editor.getText() !== expected) throw Error('Mode switch lost pending prose');
      if (!editor.view.state.selection.eq(selection)) throw Error('Mode switch moved the prose selection');
    }, mode);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  assert.equal(await page.evaluate(() => (window as any).__editor.undo()), true);
  await page.waitForFunction(() => (window as any).__editor.getText() === (window as any).__tailOriginal);
  assert.equal(await page.evaluate(() => (window as any).__editor.redo()), true);
  await page.waitForFunction(() => (window as any).__editor.getText() === (window as any).__tailOriginal + 'x');
  await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__editor;
    scope.__liveHistory.input(editor, editor.view.state.doc.length, 'y', Date.now() + 30_000);
    editor.setMode('source');
    if (editor.getText() !== scope.__tailOriginal + 'xy') throw Error('Leaving pending Live input lost text');
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.evaluate(() => {
    const scope = window as any;
    scope.__editor.setMode('live');
    if (scope.__editor.getText() !== scope.__tailOriginal + 'xy') throw Error('Returning to Live lost accepted text');
  });
  await page.evaluate(() => {
    const scope = window as any;
    const editor = scope.__editor;
    editor.focus();
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    scope.__liveHistory.input(editor, editor.view.state.doc.length, 'z', Date.now() + 40_000);
    scope.__liveHistory.setLocalStatuses([{ target: 'sample.md', exists: false }]);
    editor.refreshDecorations();
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('[local]') }, scrollIntoView: true });
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    for (const cursor = scope.__liveHistory.decorations(scope.__editor).iter(); cursor.value; cursor.next()) {
      if (cursor.value.spec.widget?.constructor.name === 'MissingLocalLinkWidget') return true;
    }
    return false;
  }), true, 'a resource change during pending plain input must invalidate the complete projection and refresh its warning');
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).__editor.destroy());
  console.log('Live settlement geometry and repeated production Editor undo/redo checkpoints passed');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
  fs.rmSync(directory, { recursive: true, force: true });
}
