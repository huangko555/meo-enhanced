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

const scannerContractCases: ReadonlyArray<Readonly<{
  label: string;
  text: string;
  options?: Parameters<typeof scanLatexMath>[1];
  expected: ReturnType<typeof scanLatexMath>;
}>> = [
  {
    label: 'inline, display, and later prose remain independently bounded',
    text: 'lead $x^2$ middle $$y_1$$ tail',
    expected: [
      { from: 5, to: 10, mode: 'inline', content: 'x^2', raw: '$x^2$' },
      { from: 18, to: 25, mode: 'display', content: 'y_1', raw: '$$y_1$$', fencedDisplay: false }
    ]
  },
  ...[0, 1, 2, 3].map((indent): Readonly<{
    label: string;
    text: string;
    expected: ReturnType<typeof scanLatexMath>;
  }> => {
    const spaces = ' '.repeat(indent);
    const text = `${spaces}$$\n${spaces}x^2\n${spaces}$$`;
    return {
      label: `fenced display math preserves the ${indent}-space source boundary`,
      text,
      expected: [{
        from: indent,
        to: text.length,
        mode: 'display',
        content: 'x^2',
        raw: `$$\n${spaces}x^2\n${spaces}$$`,
        fencedDisplay: true
      }]
    };
  }),
  {
    label: 'currency and ordinary prose do not consume a later formula',
    text: 'Pay $12.50 and save $5 today; use $x^2$ after $hello world$.',
    expected: [{ from: 34, to: 39, mode: 'inline', content: 'x^2', raw: '$x^2$' }]
  },
  {
    label: 'escaped dollars and an unclosed line do not consume later content',
    text: 'literal \\$not-math\\$ and $unfinished\nthen $z_3$ tail',
    expected: [{ from: 42, to: 47, mode: 'inline', content: 'z_3', raw: '$z_3$' }]
  },
  {
    label: 'code-like ranges are excluded without hiding following math',
    text: '`$code$` then $a+b$',
    options: { excludedRanges: [{ from: 0, to: 8 }] },
    expected: [{ from: 14, to: 19, mode: 'inline', content: 'a+b', raw: '$a+b$' }]
  },
  {
    label: 'brace errors recover at a later independent formula',
    text: '$\\frac{a}{b$ prose then $c^2$ tail',
    expected: [{ from: 24, to: 29, mode: 'inline', content: 'c^2', raw: '$c^2$' }]
  }
];

for (const { label, text, options, expected } of scannerContractCases) {
  assert.deepEqual(scanLatexMath(text, options), expected, label);
}

console.log('Shared LaTeX math scanner checks passed');
