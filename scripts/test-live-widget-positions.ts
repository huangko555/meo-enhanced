import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'explicit-background-syntax-publication', setup(builder) {
    builder.onLoad({ filter: /webview[\\/]src[\\/]liveMode\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'return buildDecorations(state, fallback, extra.changes);';
      assert.equal(source.split(boundary).length, 2);
      return { loader: 'ts', contents: source.replace(boundary,
        '((globalThis as any).__widgetPositionFullBuilds ??= 0); (globalThis as any).__widgetPositionFullBuilds++; ' + boundary) };
    });
    builder.onLoad({ filter: /@codemirror[\\/]language[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const boundary = 'Language.setState = /*@__PURE__*/StateEffect.define();';
      assert.equal(source.split(boundary).length, 2, 'the fixture must use the real parser publication effect');
      return { loader: 'js', contents: source.replace(boundary, boundary + `
        globalThis.__publishWidgetSyntax = (view, unknown = false) => view.dispatch({ effects: [
          Language.setState.of(new LanguageState(view.state.field(Language.state).context)),
          ...(unknown ? [StateEffect.define().of(true)] : [])
        ] });`) };
    });
  } }] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width: 1100, height: 900 });
  await page.setContent('<style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const text = '---\ntitle: Inline input\n---\n\n[^n] reference before the edit.\n\nEDIT\n\n**Bold** and [local](sample.md).\n\n- [ ] done\n\n'
    + '| Name | Value |\n| --- | --- |\n| [^n] | 42 |\n\n$$\nx^2=1\n$$\n\n'
    + '![sample](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PC9zdmc+)\n\n'
    + '<div>HTML body</div>\n\n```js\nconst value = 42;\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n'
    + '```math\nx^2+1\n```\n\n'
    + 'Ordinary paragraph.\n\n'.repeat(4_100)
    + Array.from({ length: 180 }, (_, index) => `- [ ] DEEP-${index}\n\n\`\`\`js\nconst deep = ${index};\n\`\`\`\n\n$x^2$\n\n`).join('')
    + '[^n]: Definition.\n\nTAIL';
  await page.evaluate(text => {
    const scope = window as any, api = scope.__liveHistory;
    const editor = scope.__editor = api.create({ parent: document.getElementById('editor'), text, initialMode: 'live', onApplyChanges() {} });
    editor.focus(); api.parse(editor);
    editor.view.dispatch({ selection: { anchor: text.indexOf('EDIT') + 4 }, scrollIntoView: true });
  }, text);
  await page.waitForSelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea');
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor, api = scope.__liveHistory;
    api.input(editor, editor.view.state.selection.main.head, 'x');
    scope.__mapped = api.decorations(editor);
    scope.__mappedPositions = structuredClone(api.positionSnapshot(editor));
    scope.__publishWidgetSyntax(editor.view);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  assert.equal(await page.evaluate(() => {
    const scope = window as any;
    return scope.__mapped === scope.__liveHistory.decorations(scope.__editor);
  }), true, 'word input must reuse the complete presentation with all supported widget kinds');
  assert.deepEqual(await page.evaluate(() => {
    const scope = window as any;
    scope.__editor.refreshDecorations();
    return scope.__liveHistory.positionSnapshot(scope.__editor);
  }), await page.evaluate(() => (window as any).__mappedPositions),
    'all projected source ranges and cross-document footnote targets must match a complete build');
  for (const target of ['Inline input', 'Bold', 'const value', 'x^2+1', 'local', 'Definition.']) {
    await page.evaluate(target => {
      const editor = (window as any).__editor;
      editor.view.dispatch({ selection: { anchor: editor.getText().indexOf(target) + 2 }, scrollIntoView: true });
    }, target);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(target => {
      const scope = window as any, editor = scope.__editor, api = scope.__liveHistory;
      const position = editor.getText().indexOf(target) + 2;
      scope.__inlineBuilds = scope.__widgetPositionFullBuilds ?? 0;
      // None of these targets edits the table. Keep its actual mounted inputs
      // and rendered cells as witnesses, including updates after parse arrival.
      scope.__inlineTableNodes = [...editor.view.dom.querySelectorAll('.meo-md-html-table-shell')].flatMap(root => {
        const nodes: Node[] = [root]; const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
        while (walker.nextNode()) nodes.push(walker.currentNode);
        return nodes;
      });
      api.input(editor, position, 'x');
      scope.__inlineSet = api.decorations(editor);
      scope.__inlinePositions = structuredClone(api.positionSnapshot(editor));
      // Publish the actual parser result now as well as allowing its normal
      // idle callback. This makes the input/parse handoff independent of timing.
      scope.__publishWidgetSyntax(editor.view);
    }, target);
    await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
    // If outer syntax is not ready on the input frame, the changed block may
    // publish once later. RangeSet identity is then intentionally different;
    // full-document rebuilding and replacing unaffected DOM remain forbidden.
    assert.equal(await page.evaluate(() => {
      const scope = window as any;
      return (scope.__widgetPositionFullBuilds ?? 0) - scope.__inlineBuilds;
    }), 0, `${target}: settling inline input must not rebuild the whole Live document`);
    assert.equal(await page.evaluate(() => (window as any).__inlineTableNodes.every((node: Node) => node.isConnected)), true,
      `${target}: unchanged mounted table content must retain its actual DOM`);
    assert.deepEqual(await page.evaluate(() => {
      const scope = window as any;
      scope.__editor.refreshDecorations();
      return scope.__liveHistory.positionSnapshot(scope.__editor);
    }), await page.evaluate(() => (window as any).__inlinePositions),
    `${target}: dirty-block presentation and all distant widget positions must match a full build`);
  }
  const unknownPublication = await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor, api = scope.__liveHistory;
    const before = api.decorations(editor), positions = api.positionSnapshot(editor);
    scope.__publishWidgetSyntax(editor.view, true);
    return { invalidated: api.decorations(editor) !== before, positions, after: api.positionSnapshot(editor) };
  });
  assert.ok(unknownPublication.invalidated, 'an unknown effect alongside parser publication must still invalidate presentation');
  assert.deepEqual(unknownPublication.after, unknownPublication.positions,
    'conservative rebuilding must retain the exact canonical widget positions');
  await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('EDITx') }, scrollIntoView: true });
  });
  await page.waitForSelector('.meo-task-checkbox');
  await page.click('.meo-task-checkbox');
  assert.equal(await page.evaluate(() => (window as any).__editor.getText().includes('- [x] done')), true,
    'a rebased checkbox must edit its own source');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  const batch = await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor;
    editor.focus();
    const from = editor.getText().indexOf('EDITx') + 5;
    editor.view.dispatch({ selection: { anchor: from } });
    const before = scope.__liveHistory.decorations(editor).size;
    const first = editor.view.state.update({ changes: { from, insert: 'y' }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
    const firstSize = scope.__liveHistory.decorations({ view: { state: first.state } }).size;
    const second = first.state.update({ changes: { from: from + 1, insert: '*' }, selection: { anchor: from + 2 }, userEvent: 'input.type' });
    editor.view.dispatch([first, second]);
    const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
    return { actual: Number(table?.dataset.tableFrom), expected: editor.getText().indexOf('| Name |'), firstSize, before };
  });
  assert.equal(batch.firstSize, batch.before, 'the batch must start with a complete widget projection');
  assert.equal(batch.actual, batch.expected, 'a mixed transaction batch must not project an already-rebased table twice');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  await page.$eval('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea', input => {
    const textarea = input as HTMLTextAreaElement;
    textarea.focus(); textarea.value = 'mapped-cell';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => (window as any).__editor.getText().includes('| mapped-cell | 42 |')), true,
    'a mounted table must keep editing its current source after mapping and batching');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('DEEP-179') }, scrollIntoView: true });
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-line')]
    .some(line => line.textContent?.includes('DEEP-179') && line.querySelector('.meo-task-checkbox')));
  let deepCheckbox;
  for (const line of await page.$$('.cm-line')) if (await line.evaluate(element => element.textContent?.includes('DEEP-179'))) {
    deepCheckbox = await line.$('.meo-task-checkbox'); break;
  }
  assert.ok(deepCheckbox, 'scrolling must restore real controls before interaction');
  await deepCheckbox.click();
  assert.ok(await page.evaluate(() => (window as any).__editor.getText().includes('- [x] DEEP-179')),
    'a rehydrated distant checkbox must edit the right source after earlier insertions');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  await page.evaluate(() => {
    const scope = window as any;
    scope.__liveHistory.beginComposition(scope.__editor);
    scope.__compositionPresentation = scope.__liveHistory.decorations(scope.__editor);
    scope.__editor.view.scrollDOM.scrollTop = 0;
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(await page.evaluate(() => {
    const scope = window as any;
    return scope.__compositionPresentation === scope.__liveHistory.decorations(scope.__editor);
  }), 'viewport hydration must wait while composition owns the presentation');
  await page.evaluate(() => {
    const scope = window as any;
    scope.__liveHistory.completeComposition(scope.__editor);
  });
  await page.waitForFunction(() => {
    const scope = window as any, editor = scope.__editor;
    if (scope.__liveHistory.pending(editor)) return false;
    let placeholders = 0;
    scope.__liveHistory.decorations(editor).between(editor.view.viewport.from, editor.view.viewport.to,
      (_from: number, _to: number, value: any) => { if (value.spec.widget?.constructor.name === 'ViewportWidgetPlaceholder') placeholders++; });
    return placeholders === 0;
  });
  await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor, api = scope.__liveHistory;
    const from = editor.getText().indexOf('[^n] reference') + 3;
    editor.view.dispatch({ selection: { anchor: from } });
    api.input(editor, from, 'new');
    scope.__unproven = api.decorations(editor);
    scope.__publishWidgetSyntax(editor.view);
  });
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__editor));
  const changedReference = await page.evaluate(() => {
    const scope = window as any, editor = scope.__editor, api = scope.__liveHistory;
    const rebuilt = api.decorations(editor) !== scope.__unproven;
    const projected = api.positionSnapshot(editor);
    const notes = api.footnotes(editor), freshNotes = api.freshFootnotes(editor);
    editor.refreshDecorations();
    return { rebuilt, projected, fresh: api.positionSnapshot(editor), notes, freshNotes,
      exact: editor.getText().includes('[^nnew] reference') };
  });
  assert.ok(changedReference.rebuilt && changedReference.exact,
    'parser publication must not certify a provisional presentation after a reference-label edit');
  assert.deepEqual(changedReference.projected, changedReference.fresh);
  assert.deepEqual(changedReference.notes, changedReference.freshNotes, 'global footnote dependencies must still refresh');
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).__editor.destroy());
  console.log('Projected images, math, Mermaid, HTML, code, checkboxes, footnotes and mounted tables preserve source positions');
} catch (error) { primaryError = error; throw error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
