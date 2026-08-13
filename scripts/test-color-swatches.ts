import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectHexColorRangesFromText } from '../src/shared/hexColorSwatches';

function sources(text: string): string[] {
  return collectHexColorRangesFromText(text).map((range) => text.slice(range.from, range.to));
}

const supported = 'Hex #abc #abcd #aabbcc #aabbccdd';
const expected = ['#abc', '#abcd', '#aabbcc', '#aabbccdd'];
if (JSON.stringify(sources(supported)) !== JSON.stringify(expected)) {
  throw new Error(`Supported colors were not collected: ${JSON.stringify(sources(supported))}`);
}

assert.deepEqual(
  sources('linear-gradient(red, blue) value (#abc) url(x) value (#abcd)'),
  ['#abc', '#abcd'],
  'HEX after closed CSS functions must remain independently collectible'
);
assert.deepEqual(
  sources('linear-gradient("close ) #abc", nested(fn(#def)), blue) #123456 url("x(#456)") #abcd'),
  ['#123456', '#abcd'],
  'quoted close-parens and nested calls must not leak or swallow HEX ranges'
);
assert.deepEqual(
  sources('linear-gradient("escaped \\" ) #abc", red) #aabbcc'),
  ['#aabbcc'],
  'escaped quotes inside excluded functions must not close their string early'
);
assert.deepEqual(
  sources('url(one) linear-gradient(red, blue) radial-gradient(circle, white) --x:#fff'),
  ['#fff'],
  'multiple closed functions must not hide later custom-property HEX values'
);
assert.deepEqual(
  sources('linear-gradient(red, (#abc) tail #def'),
  [],
  'an unclosed excluded function conservatively owns the remaining text'
);

const excludedByBoundary = [
  'heading#abc',
  'color-#fff',
  '#12345',
  '#1234567',
  '##abc',
  'https://example.com/#abc',
  'https://example.com/?color=#abc',
  '[section](#abc)',
  '#abc/tag',
  'url(#abc)',
  '`#abc`',
  '<span style="color:#abc">'
].join(' ');
if (sources(excludedByBoundary).length !== 0) {
  throw new Error(`Invalid or embedded colors were collected: ${JSON.stringify(sources(excludedByBoundary))}`);
}

const plainCssText = [
  'rgb(10, 20, 30)',
  'rgba(10 20 30 / 50%)',
  'hsl(120deg 50% 40%)',
  'hsla(0, 100%, 50%, .4)',
  'red',
  'rebeccapurple',
  'linear-gradient(#fff, red)',
  'radial-gradient(circle, #0008, transparent)'
].join(' ');
if (sources(plainCssText).length !== 0) {
  throw new Error(`Non-HEX CSS text must remain undecorated: ${JSON.stringify(sources(plainCssText))}`);
}

const largeFixture = Array.from(
  { length: 2_000 },
  (_, index) => `url("asset-${index}(#000)") linear-gradient("close ) #111", fn(#222)) --tone-${index}:#abc;`
).join('\n');
assert.equal(
  collectHexColorRangesFromText(largeFixture).length,
  2_000,
  'large input with many functions and HEX values must preserve one result per line'
);

const collectorSource = readFileSync(new URL('../src/shared/hexColorSwatches.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  collectorSource,
  /(?:slice|substring)\(\s*0\s*,\s*(?:index|from|match)/,
  'collector must not rescan a growing prefix for each HEX match'
);

console.log('color swatch parser checks passed');
