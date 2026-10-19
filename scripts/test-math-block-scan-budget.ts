import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { installMathTransform } from '../src/export/mathTransform';

function renderMeasured(text: string) {
  const md = new MarkdownIt();
  installMathTransform(md);
  let readUnits = 0;
  // Observe the real block rule's source projection rather than wall time.
  md.block.ruler.before('meo-math-block', 'measure-math-source', state => {
    if (!(state as any).__measuredMathSource) {
      (state as any).__measuredMathSource = true;
      const original = state.getLines;
      state.getLines = function (...args) {
        const value = original.apply(this, args);
        readUnits += value.length;
        return value;
      };
    }
    return false;
  });
  return { html: md.render(text), get readUnits() { return readUnits; } };
}

const section = (index: number) => `## Section ${index}\n\n$$\nx_{${index}} + 1\n$$\n\nA paragraph after the formula.\n\n`;
const text = Array.from({ length: 256 }, (_, index) => section(index)).join('');
const actual = renderMeasured(text);
assert.equal(actual.html, Array.from({ length: 256 }, (_, index) => renderMeasured(section(index)).html).join(''),
  'adjacent formulas preserve their exact presentation');
assert.ok(actual.readUnits < text.length * 2,
  `each formula must project only its own scope, not every following section (${actual.readUnits} units for ${text.length})`);

for (const text of [
  '> $$\n> x + 1\n> $$\n\nOutside.',
  '- $$\n  x + 1\n  $$\n\nOutside.',
  '$$\n\n$$\n\n$$\nx\n$$',
  '$$\nx\n\n# Boundary\n\n$$\ny\n$$',
  '$$\nx\n```js\nconst x = 1;\n```\n$$\ny\n$$',
  '$$\nx\n> $$\n> quoted\n> $$\n\n$$\ny\n$$'
]) {
  const measured = renderMeasured(text);
  assert.ok(measured.readUnits < text.length * 4, 'malformed/container scopes stay bounded');
}
console.log('Display math source projection stays linear across a whole document');
