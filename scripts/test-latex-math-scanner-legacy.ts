import assert from 'node:assert/strict';
import {
  collectLatexMathRanges as collectWebviewLatexMathRanges,
  parseLatexMathAt
} from '../webview/src/helpers/math';
import { collectLatexMathRanges as collectExportLatexMathRanges } from '../src/export/math';

const commonCases = [
  {
    text: 'escaped \\$not$ then $a$',
    expected: [{ from: 20, to: 23, mode: 'inline', content: 'a', raw: '$a$' }]
  },
  {
    text: '$$\n\\frac{a}{b}\n$$',
    expected: [{
      from: 0,
      to: 17,
      mode: 'display',
      content: '\\frac{a}{b}',
      raw: '$$\n\\frac{a}{b}\n$$',
      fencedDisplay: true
    }]
  },
  {
    text: '$12.50$ $hello world$ $x',
    expected: []
  },
  {
    text: '$\\text{a $ b}$',
    expected: [{
      from: 0,
      to: 14,
      mode: 'inline',
      content: '\\text{a $ b}',
      raw: '$\\text{a $ b}$'
    }]
  }
] as const;

for (const { text, expected } of commonCases) {
  assert.deepEqual(collectWebviewLatexMathRanges(text), expected);
  assert.deepEqual(collectExportLatexMathRanges(text), expected);
}

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

console.log('Legacy LaTeX math scanner characterization passed');
