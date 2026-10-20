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
        + '\n      (globalThis as any).__paletteBuilds = ((globalThis as any).__paletteBuilds ?? 0) + 1;') };
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
try {
  const page = await browser.newPage(); await page.setViewport({ width: 920, height: 380 });
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
  assert.deepEqual(errors, [], 'scrolling, input, resize, modes and disposal must not dispatch during a view update');
  console.log('Physical palette: visible colors, unchanged DOM overscan, intra-buffer scrolling, deferred input, resize, modes and disposal passed');
} catch (error) { primaryError = error; throw error; }
finally {
  try { if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
  finally { server.stop(true); }
}
