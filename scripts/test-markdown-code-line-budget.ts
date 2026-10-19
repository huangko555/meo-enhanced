import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { collectMarkdownCodeLines } from '../src/export/markdownCodeLines';

const originalParse = MarkdownIt.prototype.parse;
let inlineChildren = 0;
MarkdownIt.prototype.parse = function (...args) {
  const tokens = originalParse.apply(this, args);
  for (const token of tokens) inlineChildren += token.children?.length ?? 0;
  return tokens;
};
try {
  const source = [
    '**Formatted** [prose](https://example.invalid) with $x^2$ and `inline code`.', '',
    '> ```js', '> const x = 1;', '> ```', '',
    '- item', '', '  ```md', '  **literal**', '  ```', '',
    '    indented code', '', '| A | B |', '| --- | --- |', '| x | y |'
  ].join('\n');
  const expected = new Set<number>();
  for (const token of new MarkdownIt().parse(source, {})) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
      for (let index = token.map[0]; index < token.map[1]; index++) expected.add(index);
    }
  }
  inlineChildren = 0;
  assert.deepEqual(collectMarkdownCodeLines(source), expected, 'block-only discovery preserves container and code ranges');
  assert.equal(inlineChildren, 0, 'code-line discovery must not tokenize every prose/link/code span');
  assert.deepEqual(collectMarkdownCodeLines('    | A | B |\n    | --- | --- |\n    | x | y |'), new Set(),
    'the existing indented table extension stays available');
} finally { MarkdownIt.prototype.parse = originalParse; }
console.log('Markdown code-line discovery skips unused inline parsing');
