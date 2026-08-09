import assert from 'node:assert/strict';
import { scanLatexMath, scanLatexMathAt } from '../src/shared/latexMathScanner';

assert.deepEqual(scanLatexMath('before $x^2$ after'), [
  {
    from: 7,
    to: 12,
    mode: 'inline',
    content: 'x^2',
    raw: '$x^2$'
  }
]);

assert.deepEqual(scanLatexMath('$$\n\\frac{a}{b}\n$$'), [
  {
    from: 0,
    to: 17,
    mode: 'display',
    content: '\\frac{a}{b}',
    raw: '$$\n\\frac{a}{b}\n$$',
    fencedDisplay: true
  }
]);

assert.deepEqual(scanLatexMath('escaped \\$not$ then $a$ and $b_2$'), [
  { from: 20, to: 23, mode: 'inline', content: 'a', raw: '$a$' },
  { from: 28, to: 33, mode: 'inline', content: 'b_2', raw: '$b_2$' }
]);

assert.deepEqual(scanLatexMath('$12.50$ $hello world$ $x'), []);
assert.deepEqual(scanLatexMath('$\\text{a $ b}$'), [
  {
    from: 0,
    to: 14,
    mode: 'inline',
    content: '\\text{a $ b}',
    raw: '$\\text{a $ b}$'
  }
]);

assert.deepEqual(
  scanLatexMath('`$code$` and $x$', { excludedRanges: [{ from: 0, to: 8 }] }),
  [{ from: 13, to: 16, mode: 'inline', content: 'x', raw: '$x$' }]
);

assert.deepEqual(scanLatexMath('prefix $$a\nb$$ suffix'), []);
assert.deepEqual(scanLatexMath('one $a$ two $$b$$ three'), [
  { from: 4, to: 7, mode: 'inline', content: 'a', raw: '$a$' },
  { from: 12, to: 17, mode: 'display', content: 'b', raw: '$$b$$', fencedDisplay: false }
]);
assert.deepEqual(scanLatexMath('$**bold**$ $this is ordinary prose$'), []);
assert.deepEqual(scanLatexMath(`$${'a'.repeat(121)}$`), []);
assert.deepEqual(
  scanLatexMath('$a xx$code$yy + b$', { excludedRanges: [{ from: 5, to: 11 }] }),
  [{
    from: 0,
    to: 18,
    mode: 'inline',
    content: 'a xx$code$yy + b',
    raw: '$a xx$code$yy + b$'
  }]
);

assert.deepEqual(scanLatexMathAt('$$x$$', 1), {
  from: 1,
  to: 4,
  mode: 'inline',
  content: 'x',
  raw: '$x$'
});
assert.deepEqual(scanLatexMathAt('prefix\n$$\nx\n$$', 7), {
  from: 7,
  to: 14,
  mode: 'display',
  content: 'x',
  raw: '$$\nx\n$$',
  fencedDisplay: true
});
assert.equal(scanLatexMathAt('prefix $$\nx\n$$', 7), null);

console.log('Shared LaTeX math scanner checks passed');
