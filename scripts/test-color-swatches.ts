import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
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

const unmatchedInlineCode = 'Unmatched ` inline marker\n\n#abc';
assert.deepEqual(
  sources(unmatchedInlineCode),
  ['#abc'],
  'an unmatched inline backtick must remain ordinary Markdown text'
);
const backslashBacktickBoundaries = [
  ['odd escaped unmatched', 'odd \\` literal\n\n#abc', ['#abc']],
  ['even unescaped unmatched', 'even \\\\` literal\n\n#abc', ['#abc']],
  ['odd escaped then unmatched', 'odd \\`#abc` #def', ['#abc', '#def']],
  ['even unescaped and closed', 'even \\\\`#abc` #def', ['#def']]
] as const;
for (const [label, text, expectedSources] of backslashBacktickBoundaries) {
  assert.deepEqual(sources(text), expectedSources, `${label} must follow Markdown backtick escaping`);
}
const backslash = String.fromCharCode(92);
const backtick = String.fromCharCode(96);
const escapedMultiBacktick = `${backslash}${backtick.repeat(2)}#abc${backtick} #def`;
const escapedMultiTokens = new MarkdownIt().parseInline(escapedMultiBacktick, {})[0]?.children ?? [];
assert.deepEqual(
  escapedMultiTokens.map((token) => [token.type, token.content]),
  [['text', backtick], ['code_inline', '#abc'], ['text', ' #def']],
  'project markdown-it must define the escaped multi-backtick fixture semantics'
);
assert.deepEqual(
  sources(escapedMultiBacktick),
  ['#def'],
  'an odd slash escapes only the first backtick of a multi-backtick run'
);
const escapedRunMatrix = [
  ['odd single matched becomes text', `${backslash}${backtick}#abc${backtick} #def`, ['#abc', '#def']],
  ['odd triple leaves paired double', `${backslash}${backtick.repeat(3)}#abc${backtick.repeat(2)} #def`, ['#def']],
  ['odd triple without double close stays text', `${backslash}${backtick.repeat(3)}#abc${backtick} #def`, ['#abc', '#def']],
  ['even double stays paired double', `${backslash.repeat(2)}${backtick.repeat(2)}#abc${backtick.repeat(2)} #def`, ['#def']]
] as const;
for (const [label, text, expectedSources] of escapedRunMatrix) {
  assert.deepEqual(sources(text), expectedSources, label);
}

const excludedByBoundary = [
  'heading#abc',
  'color-#fff',
  '#12345',
  '#1234567',
  '##abc',
  'https://example.com/#abc',
  'https://example.com/?color=#abc',
  'HTTPS://example.com/?color=#abc',
  '//example.com/?color=#abc',
  '[section](#abc)',
  '[section]( #abc)',
  '[section](\n#abc)',
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
const unmatchedDestinations = `${Array.from({ length: 2_500 }, (_, index) => `[label-${index}](`).join(' ')}\n#abc`;
assert.deepEqual(
  sources(unmatchedDestinations),
  ['#abc'],
  'many unmatched link destinations must remain ordinary text without hiding a trailing HEX value'
);
const unmatchedBacktickRuns = `${Array.from(
  { length: 180 },
  (_, index) => `${'`'.repeat(index + 1)}run-${index}`
).join(' ')}\n#abcd`;
assert.deepEqual(
  sources(unmatchedBacktickRuns),
  ['#abcd'],
  'many different-length unmatched backtick runs must not hide a trailing HEX value'
);
const mixedBacktickRuns = [
  'odd \\` literal #abc',
  'even \\\\`#def` outside #123456',
  'unmatched `` marker',
  'matched ```#456``` outside #aabbccdd'
].join('\n');
assert.deepEqual(
  sources(mixedBacktickRuns),
  ['#abc', '#123456', '#aabbccdd'],
  'escaped, matched and unmatched backtick runs must retain their existing Markdown semantics'
);
assert.doesNotMatch(
  collectorSource,
  /function\s+scan(?:BacktickCode|MarkdownLinkDestination)\b/,
  'delimiter matching must be summarized once instead of rescanning from each opener'
);
assert.match(
  collectorSource,
  /function\s+collectDelimiterSummary\b/,
  'collector must build one private delimiter summary before producing excluded ranges'
);

console.log('color swatch parser checks passed');
