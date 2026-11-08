import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { highlightTree, type Highlighter } from '@lezer/highlight';
import { NodeProp, Tree } from '@lezer/common';
import { editorMarkdownLanguage } from '../webview/src/liveMode';
import { liveHighlightStyle, sourceHighlightStyle } from '../webview/src/theme';
import { syntaxHighlightWindow } from '../webview/src/editor/viewportSyntaxHighlighting';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const fixture = '# Heading **bold**\n\n> Quote *emphasis* with [link](https://example.test)\n>\n> - nested `code`\n\n'
  + '| Header | Value |\n| --- | --- |\n| ~~deleted~~ | **strong** |\n\n'
  + '```javascript\nconst answer = { text: "hello", number: 42 }; // comment\n```\n\n'
  + '<section class="hello"><b>HTML</b></section>\n\n<style>div { color: red; }</style>\n\n'
  + '<script>const nested = "value";</script>\n\n'
  + '> ```javascript\n> const one = 1;\n>\n> const two = "value";\n> ```\n\n'
  + 'Reference[^note] and [label][target].\n\n[^note]: Definition\n\n[target]: https://example.test\n\n';
const state = EditorState.create({ doc: fixture.repeat(120), extensions: editorMarkdownLanguage });
const tree = ensureSyntaxTree(state, state.doc.length, 10_000)!;
assert.ok(tree && tree.length > 30_000, 'exercise a real mixed Markdown tree with anonymous balancing groups');
function spans(tree: Tree, highlighter: Highlighter, from: number, to: number) {
  const result: Array<[number, number, string]> = [];
  highlightTree(tree, highlighter, (start, end, classes) => result.push([start, end, classes]), from, to);
  return result;
}
let comparisons = 0;
for (const style of [sourceHighlightStyle, liveHighlightStyle]) {
  for (let index = 0; index < 64; index++) {
    const from = Math.floor((tree.length - 300) * index / 63), to = from + 300;
    assert.deepEqual(spans(syntaxHighlightWindow(tree, from, to), style, from, to), spans(tree, style, from, to),
      `window must preserve absolute offsets, ancestor styling, mixed-language mounts and boundaries at ${from}`);
    comparisons++;
  }
}
const proof = new NodeProp<string>({ perNode: true });
const marked = new Tree(tree.type, tree.children, tree.positions, tree.length, [[proof, 'preserved']]);
assert.equal(syntaxHighlightWindow(marked, tree.length - 300, tree.length).prop(proof), 'preserved');
assert.equal(syntaxHighlightWindow(tree, 0, tree.length), tree, 'whole-document reads retain the original tree');
const from = tree.length - 300;
const cursor = tree.cursor(), prototype = Object.getPrototypeOf(cursor), next = prototype.nextSibling;
let steps = 0;
prototype.nextSibling = function(...args: any[]) { steps++; return next.apply(this, args); };
let before: number, after: number;
try {
  spans(tree, sourceHighlightStyle, from, tree.length); before = steps;
  steps = 0;
  spans(syntaxHighlightWindow(tree, from, tree.length), sourceHighlightStyle, from, tree.length); after = steps;
} finally { prototype.nextSibling = next; }
assert.ok(before! > 1_000 && after! < 200 && after! < before! / 8,
  `late viewport must not walk all preceding siblings: ${before!} -> ${after!}`);
console.log(`Viewport syntax: ${comparisons} exact mixed-language comparisons; preceding sibling work ${before!} -> ${after!}`);

const codeState = EditorState.create({ doc: '```javascript\nlet initial = 0;\n'
  + 'const value = { number: 1, text: "sample" };\n'.repeat(9_000) + '```', extensions: editorMarkdownLanguage });
const codeTree = ensureSyntaxTree(codeState, codeState.doc.length, 10_000)!;
const codeFrom = codeState.doc.line(8_800).from, codeTo = codeState.doc.line(8_810).to;
assert.deepEqual(spans(syntaxHighlightWindow(codeTree, codeFrom, codeTo), sourceHighlightStyle, codeFrom, codeTo),
  spans(codeTree, sourceHighlightStyle, codeFrom, codeTo), 'deep mounted code must retain its exact palette and offsets');
steps = 0;
prototype.nextSibling = function(...args: any[]) { steps++; return next.apply(this, args); };
try { spans(syntaxHighlightWindow(codeTree, codeFrom, codeTo), sourceHighlightStyle, codeFrom, codeTo); }
finally { prototype.nextSibling = next; }
assert.ok(steps < 1_000, `a long mounted code language must also skip preceding rows: ${steps}`);
console.log(`Deep code viewport sibling work: ${steps}`);

const build = await Bun.build({ entrypoints: ['scripts/test-live-decoration-history-entry.ts'], target: 'browser', format: 'iife',
  plugins: [{ name: 'observe-real-palette-work', setup(builder) {
    builder.onLoad({ filter: /webview[\\/]src[\\/]editor[\\/]viewportSyntaxHighlighting\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text(), marker = '    private build(view: EditorView): DecorationSet {';
      assert.equal(source.split(marker).length, 2);
      return { loader: 'ts', contents: source.replace(marker, marker
        + '\n      (globalThis as any).__paletteBuilds = ((globalThis as any).__paletteBuilds ?? 0) + 1;')
        .replace('        highlightTree(syntaxHighlightWindow(this.tree, from, to)',
          '        (globalThis as any).__paletteRanges?.push({ from, to }); highlightTree(syntaxHighlightWindow(this.tree, from, to)')
        .replace('            view.update([]);', '            (globalThis as any).__paletteCommits = ((globalThis as any).__paletteCommits ?? 0) + 1; view.update([]);') };
    });
  } }] });
assert.ok(build.success, build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/bundle.js') return new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  if (pathname === '/style.css') return new Response(Bun.file('webview/src/styles.css'), { headers: { 'content-type': 'text/css; charset=utf-8' } });
  return new Response('<!doctype html><link rel="stylesheet" href="/style.css"><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div><script src="/bundle.js"></script>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
let primaryError: unknown;
let phase = 'source palette';
let diagnose: (() => Promise<unknown>) | undefined;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 920, height: 380 });
  diagnose = () => page.evaluate(() => {
    const editor = (window as any).__paletteEditor;
    if (!editor) return null;
    const actual = editor.getText(), original = (window as any).__paletteSource;
    let first = 0; while (first < actual.length && actual[first] === original[first]) first++;
    return { position: editor.view.state.selection.main.head, focused: editor.hasFocus(),
      history: editor.getHistoryDepth(), firstDifference: first, fragment: actual.slice(Math.max(0, first - 20), first + 40) };
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.url.href);
  assert.deepEqual(errors, [], 'the production Editor fixture must load');
  await page.evaluate(() => {
    const scope = window as any;
    scope.__paletteSource = '## Heading **strong** *emphasis* [link](https://example.test/) `code` words.\n'.repeat(6_000);
    scope.__paletteEditor = scope.__liveHistory.create({ parent: document.getElementById('app'), text: scope.__paletteSource, initialMode: 'source' });
    scope.__liveHistory.parse(scope.__paletteEditor);
    scope.__paletteEditor.scrollToLine(3_000, 'center');
  });
  const settle = () => page.evaluate(async () => {
    for (let frame = 0; frame < 12; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const verifyBand = async () => {
    await settle();
    const result = await page.evaluate(() => {
      const view = (window as any).__paletteEditor.view, bounds = view.scrollDOM.getBoundingClientRect();
      const lines = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')];
      const visible = lines.filter(line => { const r = line.getBoundingClientRect(); return r.top >= bounds.top && r.bottom <= bounds.bottom && line.textContent; });
      const far = lines.filter(line => { const r = line.getBoundingClientRect(); return r.top > bounds.bottom + 160 || r.bottom < bounds.top - 160; });
      return { visible: visible.length, visibleColored: visible.filter(line => line.querySelector('span[class]')).length,
        buffered: far.length, bufferedColored: far.filter(line => line.querySelector('span[class]')).length };
    });
    assert.ok(result.visible > 3 && result.buffered > 3, 'keep the real CodeMirror DOM overscan and physical viewport in the fixture');
    assert.equal(result.visibleColored, result.visible, 'every physically visible line retains its complete palette');
    assert.equal(result.bufferedColored, 0, 'offscreen DOM overscan must not force a large palette repaint');
  };
  await verifyBand();
  for (const pixels of [90, -160, 240]) {
    await page.evaluate(pixels => { (window as any).__paletteEditor.view.scrollDOM.scrollTop += pixels; }, pixels);
    await verifyBand();
  }
  await page.evaluate(() => {
    const scope = window as any, view = scope.__paletteEditor.view, bounds = view.scrollDOM.getBoundingClientRect();
    const line = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')]
      .find(line => { const rect = line.getBoundingClientRect(); return rect.top > bounds.top + bounds.height / 2 && line.querySelector('span[class]'); })!;
    scope.__retainedPalette = { line, span: line.querySelector('span[class]') };
    scope.__paletteRanges = [];
  });
  const point = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  for (let index = 0; index < 4; index++) {
    await page.mouse.wheel({ deltaY: 36 });
    await verifyBand();
  }
  const visited = await page.evaluate(() => (window as any).__paletteRanges as Array<{ from: number; to: number }>);
  assert.ok(visited.length >= 2, 'trusted scrolling must cross multiple actual palette boundaries');
  const ordered = [...visited].sort((a, b) => a.from - b.from || a.to - b.to);
  assert.ok(ordered.every((range, index) => !index || range.from >= ordered[index - 1]!.to),
    `unchanged reading ranges must not be highlighted repeatedly: ${JSON.stringify(visited)}`);
  assert.equal(await page.evaluate(() => {
    const { line, span } = (window as any).__retainedPalette;
    return line.isConnected && line.querySelector('span[class]') === span;
  }), true, 'overlapping reading text must retain its native line and token DOM');
  await page.evaluate(() => { delete (window as any).__paletteRanges; });
  const pending = await page.evaluate(() => {
    const scope = window as any, editor = scope.__paletteEditor;
    scope.__paletteBuilds = 0;
    scope.__liveHistory.input(editor, editor.view.state.doc.line(3_000).to, 'x');
    scope.__liveHistory.parse(editor);
    return { pending: scope.__liveHistory.pending(editor), builds: scope.__paletteBuilds };
  });
  assert.equal(pending.pending, true);
  assert.equal(pending.builds, 0, 'accepted input and arriving syntax must map the existing palette until the input generation settles');
  await page.waitForFunction(() => !(window as any).__liveHistory.pending((window as any).__paletteEditor));
  await verifyBand();
  await page.setViewport({ width: 620, height: 480 }); await verifyBand();
  const exact = await page.evaluate(async () => {
    const scope = window as any, editor = scope.__paletteEditor, before = editor.getText();
    await editor.setMode('live'); await editor.setMode('source');
    return editor.getText() === before;
  });
  assert.ok(exact, 'palette work must preserve exact text across mode reconfiguration');
  await verifyBand();
  await page.evaluate(() => (window as any).__paletteEditor.destroy()); await settle();
  phase = 'Live palette';
  await page.evaluate(() => {
    const scope = window as any;
    scope.__paletteSource = '# Reading heading\n\nParagraph **strong** and [link](https://example.test/path) with `code`.\n\n'.repeat(1_200);
    scope.__paletteEditor = scope.__liveHistory.create({ parent: document.getElementById('app'), text: scope.__paletteSource, initialMode: 'live' });
    scope.__liveHistory.parse(scope.__paletteEditor);
    scope.__paletteEditor.scrollToLine(400, 'center');
  });
  await settle();
  const redundantPalette = await page.evaluate(() => {
    const view = (window as any).__paletteEditor.view;
    const owned = [...view.contentDOM.querySelectorAll<HTMLElement>('.meo-md-marker, .meo-md-code-marker, .meo-md-link-url-hidden, .meo-md-link')];
    const isPalette = (element: Element) => [...element.classList].some(name => !name.startsWith('meo-') && !name.startsWith('cm-'));
    return { owned: owned.length, redundant: owned.flatMap(element => [...element.querySelectorAll('span[class]')]).filter(isPalette).length };
  });
  assert.ok(redundantPalette.owned > 20, 'exercise actual Live-owned markers and link text');
  assert.equal(redundantPalette.redundant, 0, 'hidden markers and Live-styled link text must not allocate redundant syntax spans');
  const wheelPoint = await page.evaluate(() => {
    (window as any).__paletteCommits = 0;
    const view = (window as any).__paletteEditor.view;
    const bounds = view.scrollDOM.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, before: view.scrollDOM.scrollTop };
  });
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  for (let step = 0; step < 12; step++) {
    await page.mouse.wheel({ deltaY: 17 });
    await page.evaluate(async () => { for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame); });
  }
  await settle();
  const unchangedPalette = await page.evaluate(() => ({ commits: (window as any).__paletteCommits,
    top: (window as any).__paletteEditor.view.scrollDOM.scrollTop,
    text: (window as any).__paletteEditor.getText() === (window as any).__paletteSource }));
  assert.ok(unchangedPalette.top > wheelPoint.before + 100 && unchangedPalette.text, 'trusted fine scrolling must move the actual unchanged document');
  assert.equal(unchangedPalette.commits, 0, 'scrolling an unchanged empty syntax palette must not submit redundant view updates');
  const reveal = await page.evaluate(() => {
    const editor = (window as any).__paletteEditor, view = editor.view;
    const from = view.state.doc.toString().indexOf('https://example.test/path', view.viewport.from);
    editor.scrollToLine(view.state.doc.lineAt(from).number, 'center');
    view.dispatch({ selection: { anchor: from + 10 } });
    return from;
  });
  await settle();
  const revealed = await page.evaluate(from => {
    const view = (window as any).__paletteEditor.view, dom = view.domAtPos(from).node;
    const line = (dom instanceof Element ? dom : dom.parentElement)!.closest('.cm-line')!;
    const spans = [...line.querySelectorAll('span[class]')].filter(element =>
      [...element.classList].some(name => !name.startsWith('meo-') && !name.startsWith('cm-')));
    return { hidden: !!line.querySelector('.meo-md-link-url-hidden'),
      colored: spans.some(element => element.textContent?.includes('https://example.test/path')),
      selection: view.state.selection.main.head, text: view.state.doc.toString() === (window as any).__paletteSource };
  }, reveal);
  assert.equal(revealed.hidden, false, 'entering a link reveals its native URL');
  assert.ok(revealed.colored, 'revealed URL regains its original syntax palette without a new parse');
  assert.equal(revealed.selection, reveal + 10);
  assert.ok(revealed.text);
  const beforeInput = await page.evaluate(() => {
    const editor = (window as any).__paletteEditor; editor.focus();
    return { text: editor.getText(), position: editor.view.state.selection.main.head };
  });
  phase = 'Live URL typing';
  await page.keyboard.type('x');
  const edited = beforeInput.text.slice(0, beforeInput.position) + 'x' + beforeInput.text.slice(beforeInput.position);
  await page.waitForFunction(text => (window as any).__paletteEditor.getText() === text, {}, edited);
  phase = 'Live URL undo';
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await page.waitForFunction(text => (window as any).__paletteEditor.getText() === text, {}, beforeInput.text);
  phase = 'Live URL redo';
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
  await page.waitForFunction(text => (window as any).__paletteEditor.getText() === text, {}, edited);
  await settle();
  const finalInput = await page.evaluate(() => ({ focused: (window as any).__paletteEditor.hasFocus(),
    position: (window as any).__paletteEditor.view.state.selection.main.head }));
  assert.ok(finalInput.focused);
  assert.equal(finalInput.position, beforeInput.position + 1, 'redo keeps the edited URL caret');
  await page.evaluate(async () => {
    const editor = (window as any).__paletteEditor;
    await editor.setMode('source'); await editor.setMode('live');
  });
  assert.equal(await page.evaluate(() => (window as any).__paletteEditor.getText()), edited);
  await page.evaluate(() => (window as any).__paletteEditor.destroy()); await settle();
  assert.deepEqual(errors, [], 'scrolling, input, resize, modes and disposal must not dispatch during a view update');
  console.log('Physical palette: visible colors, unchanged DOM overscan, intra-buffer scrolling, deferred input, resize, modes and disposal passed');
  console.log('Live palette: no redundant marker/link spans, no empty-band commits, revealed URL colors, typing, undo/redo and mode roundtrip passed');
} catch (error) {
  primaryError = error;
  console.error(phase, diagnose ? await diagnose().catch(() => null) : null);
  throw error;
}
finally {
  try { if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
  finally { server.stop(true); }
}
