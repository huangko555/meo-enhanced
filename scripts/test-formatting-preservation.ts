import assert from 'node:assert/strict';
import { formatHtmlFragment } from '../webview/src/editor/htmlFormatting';
import { formatLatexSource } from '../webview/src/editor/latexFormatting';
import { renderMathToHtml } from '../src/shared/mathRenderer';

for (const protectedHtml of ['<pre>  a\n b</pre>', '<textarea>  a\n b </textarea>', '<code> a  b\n c </code>',
  '<p style="white-space:pre-wrap"> a  b\n c </p>', '<div style="white-space:break-spaces"> a  b </div>',
  '<img style="white-space:pre" src="sample.png">',
  '<div style="display:inline">a</div> <div style="display:inline-block">b</div>']) {
  const html = `<div>${protectedHtml}<section><p>hello</p></section></div>`;
  const offsets = [html.indexOf('hello'), html.indexOf('a'), html.indexOf('b')].filter(offset => offset >= 0);
  const result = await formatHtmlFragment(html, offsets);
  assert.equal(result.kind, 'formatted-protected');
  assert.ok(result.source.includes(protectedHtml), 'Keep protected HTML byte-for-byte');
  assert.match(result.source, /\n\s+<section>/, 'Protected nodes do not freeze ordinary siblings');
  offsets.forEach((offset, index) => assert.equal(result.source[result.offsets[index]], html[offset], 'Retain protected and ordinary cursor positions'));
  assert.equal((await formatHtmlFragment(result.source, result.offsets)).kind, 'unchanged');
}
for (const inline of ['left <span>middle</span> right', 'left<div style="display:inline">middle</div>right',
  'left <div style="display:inline">middle</div> right', '<span>a</span> <span>b</span>']) {
  const text = `<div>${inline}<section><p>hello</p></section></div>`;
  const result = await formatHtmlFragment(text, [text.indexOf('hello')]);
  assert.ok(result.kind.startsWith('formatted'));
  assert.ok(result.source.includes(inline), 'Retain meaningful inline adjacency and spaces');
}
const attributes = '<div><pre> keep\n  this </pre><section data-description="' + 'long attribute value '.repeat(7) + '" data-order="2"><p>hello</p></section></div>';
const attrResult = await formatHtmlFragment(attributes, [attributes.indexOf('hello')]);
assert.ok(attrResult.source.includes('\n    data-description='));
assert.ok(attrResult.source.includes('long attribute value '.repeat(7)), 'Attribute values remain intact');
assert.equal((await formatHtmlFragment('<div><p>hello</div>', [0])).kind, 'invalid', 'Formatting does not repair missing tags');
const unclosed = '<div><pre>not closed';
assert.equal((await formatHtmlFragment(unclosed, [0])).source, unclosed, 'Unknown protected boundary retains source');

for (const text of [String.raw`\frac12 + \sqrt x`, String.raw`\text{hello   world}`, String.raw`\def\foo{ x  y }\foo`]) {
  assert.equal((await formatLatexSource(text, [0])).kind, 'unchanged', 'A simple formula normally needs no layout change');
}
for (const text of [String.raw`\begin{aligned}a&=\frac12 + \sqrt x\\b&=2\end{aligned}`,
  String.raw`\begin{aligned}a&=\text{hello   world}\\b&=2\end{aligned}`,
  String.raw`\def\foo{ x  y }\begin{matrix}\foo&2\\3&4\end{matrix}`,
  String.raw`\def\foo{\begin{matrix} x& y \\ z&w\end{matrix}}\begin{matrix}\foo&2\\3&4\end{matrix}`,
  String.raw`\begin{array}{cc}1&2\\[3pt]333&4\end{array}`,
  String.raw`\begin{matrix}[a]&2\\3&4\end{matrix}`,
  String.raw`\begin{aligned}[t]a&=1\\*[2pt]bbb&=2\end{aligned}`,
  String.raw`\begin{aligned}a&=\begin{cases}1&x>0\\0&x<0\end{cases}\\bbbb&=2\end{aligned}`,
  '\\begin{aligned}a&=1\\\\% keep   comment\nb&=2\\end{aligned}',
  '\\begin{aligned}a&=\\text{line\n  break}\\\\b&=2\\end{aligned}']) {
  const offsets = [...text].map((_char, offset) => offset).filter(offset => !/\s/.test(text[offset]));
  const result = await formatLatexSource(text, offsets);
  assert.ok(result.kind.startsWith('formatted'), result.kind + ': ' + text);
  assert.equal(result.source.replace(/\s/g, ''), text.replace(/\s/g, ''), 'Never rewrite TeX tokens');
  for (const edit of result.edits) assert.match(text.slice(edit.from, edit.to), /^[ \t\r\n]*$/, 'Only original whitespace is edited');
  offsets.forEach((offset, index) => assert.equal(result.source[result.offsets[index]], text[offset], 'Retain every token cursor'));
  for (const exact of ['\\frac12', '\\sqrt x', '\\text{hello   world}', '\\def\\foo{ x  y }', '% keep   comment\n', '\\text{line\n  break}',
    '\\def\\foo{\\begin{matrix} x& y \\\\ z&w\\end{matrix}}']) if (text.includes(exact)) assert.ok(result.source.includes(exact), 'Protected raw source: ' + exact);
  assert.equal(renderMathToHtml(result.source, 'display'), renderMathToHtml(text, 'display'), 'Retain rendering');
  assert.equal((await formatLatexSource(result.source, [0])).kind, 'unchanged', 'Layout formatting is idempotent');
}
assert.equal((await formatLatexSource('\\frac{', [0])).kind, 'invalid');
console.log('Local preservation formatting regressions passed');
