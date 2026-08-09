import assert from 'node:assert/strict';
import {
  collectLatexMathRanges as collectWebviewLatexMathRanges,
  parseLatexMathAt
} from '../webview/src/helpers/math';
import { collectLatexMathRanges as collectExportLatexMathRanges } from '../src/export/math';

assert.deepEqual(
  collectWebviewLatexMathRanges('`$code$` and $x$', {
    baseOffset: 40,
    excludedRanges: [{ from: 0, to: 8 }]
  }),
  [{ from: 53, to: 56, mode: 'inline', content: 'x', raw: '$x$' }]
);

assert.deepEqual(parseLatexMathAt('prefix $x^2$', 7), {
  from: 7,
  to: 12,
  mode: 'inline',
  content: 'x^2',
  raw: '$x^2$'
});
assert.deepEqual(parseLatexMathAt('$$x$$', 1), {
  from: 1,
  to: 4,
  mode: 'inline',
  content: 'x',
  raw: '$x$'
});
assert.deepEqual(parseLatexMathAt('prefix\n$$\nx\n$$', 7), {
  from: 7,
  to: 14,
  mode: 'display',
  content: 'x',
  raw: '$$\nx\n$$',
  fencedDisplay: true
});
assert.equal(parseLatexMathAt('prefix $$\nx\n$$', 7), null);
assert.equal(parseLatexMathAt('$x$', 0, { allowInline: false }), null);
assert.equal(parseLatexMathAt('$$x$$', 0, { allowDisplay: false }), null);

assert.deepEqual(collectExportLatexMathRanges('before $$x^2$$ after'), [{
  from: 7,
  to: 14,
  mode: 'display',
  content: 'x^2',
  raw: '$$x^2$$',
  fencedDisplay: false
}]);

const longPlainText = 'a'.repeat(40_000);
const pointScanStart = performance.now();
for (let index = 0; index < longPlainText.length; index += 1) {
  assert.equal(parseLatexMathAt(longPlainText, index), null);
}
assert.ok(
  performance.now() - pointScanStart < 1_500,
  'parseLatexMathAt should reject non-delimiters in bounded time'
);

console.log('LaTeX math scanner caller integration checks passed');
