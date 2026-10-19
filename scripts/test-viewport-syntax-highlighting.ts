import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { highlightTree, type Highlighter } from '@lezer/highlight';
import { NodeProp, Tree } from '@lezer/common';
import { editorMarkdownLanguage } from '../webview/src/liveMode';
import { liveHighlightStyle, sourceHighlightStyle } from '../webview/src/theme';
import { syntaxHighlightWindow } from '../webview/src/editor/viewportSyntaxHighlighting';

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
