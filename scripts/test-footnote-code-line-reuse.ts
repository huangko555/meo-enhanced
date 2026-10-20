import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { prepareMarkdownWithFootnotes } from '../src/export/footnotes';
import { collectMarkdownCodeLines } from '../src/export/markdownCodeLines';
import { preparePreviewDocument } from '../src/export/runtime';

const large = Array.from({ length: 120 }, (_, index) => `Paragraph ${index} before reference[^n].\n\n| Header | Value |\n| --- | --- |\n| Cell[^n] | two |\n\n`).join('')
  + '```js\nconst literal = "[^n]";\n```\n\n[^n]: Note.';
const parse = MarkdownIt.prototype.parse;
let wholeScans = 0;
MarkdownIt.prototype.parse = function(source, environment) {
  if (source.length > 4_000) wholeScans++;
  return parse.call(this, source, environment);
};
try {
  preparePreviewDocument({ markdownText: large, sourceDocumentPath: '/fixture/notes.md', uiLanguage: 'en' }, true);
  assert.equal(wholeScans, 2, 'footnote extraction and reference rewriting must not cause a third global code scan during normalization');
} finally { MarkdownIt.prototype.parse = parse; }

const prepare = (markdown: string) => prepareMarkdownWithFootnotes({ markdown,
  sourceLines: markdown.split('\n').map((_, index) => index + 1) }, {
  target: 'html', renderMarkdown: text => text, normalizeMarkdown: text => text,
  backToReference: 'Back', backToNumberedReference: number => `Back ${number}`,
  backToReferenceOccurrence: (number, occurrence) => `Back ${number}/${occurrence}`
});
const safe = prepare('Text before note[^n].\n\n```js\nconst literal = "[^n]";\n```\n\n[^n]: Note.');
const hint = (safe as typeof safe & { bodyCodeLines?: ReadonlySet<number> }).bodyCodeLines;
assert.ok(hint, 'inline-only reference substitution must carry its proven code-line index');
assert.deepEqual([...hint], [...collectMarkdownCodeLines(safe.body.markdown)]);

// Keep fresh parsing when the insertion has no proven inline-content prefix,
// including references at block starts and inside link definitions.
for (const body of ['[^n]\n```js\ncode\n```', '[link]: [^n]\n    ```js\n    code\n    ```',
  '> [^n]\n> ```js\n> code\n> ```']) {
  const result = prepare(`${body}\n\n[^n]: Note.`);
  const codeLines = (result as typeof result & { bodyCodeLines?: ReadonlySet<number> }).bodyCodeLines;
  assert.equal(codeLines, undefined, `structurally sensitive substitution must reparse: ${body}`);
}

for (const label of ['n', 'n|x', 'n\\|x', 'n`x']) for (const container of ['', '> ', '- ']) {
  const markdown = [`| Header[^${label}] | Value |`, '| --- | --- |', `| Cell[^${label}] | two |`]
    .map(line => container + line).join('\n') + '\n\n```js\ncode\n```\n\n[^' + label + ']: Note.';
  const result = prepare(markdown);
  if (label === 'n' && !container) assert.ok(result.bodyCodeLines, 'ordinary table footnotes must share the proven index');
  if (result.bodyCodeLines) assert.deepEqual([...result.bodyCodeLines], [...collectMarkdownCodeLines(result.body.markdown)], markdown);
  else if (label.includes('|')) assert.ok(result.body.markdown.includes('footnote-ref'), 'pipe-label fallback must exercise an actual substitution');
}

let reused = 0, fallback = 0;
const prefixes = ['', 'Prefix ', '# ', '# Prefix ', '> ', '> Prefix ', '- ', '- Prefix ',
  '1. ', '1. Prefix ', '> - ', '> - Prefix ', '    ', '\t', '<!-- ', '<div>', '<!DECL ', '<?processing '];
const references = ['[^n]', '`[^n]`', '\\[^n]', '<span>[^n]</span>', '[link]: [^n]', '[^missing]', '[^n] and[^n]'];
for (const prefix of prefixes) for (const reference of references) for (const following of [
  '\n```js\ncode\n```', '\n\n    ```js\n    code\n    ```', '\n---\n\n| A | B |\n| - | - |', '\n\n> ```js\n> code\n> ```'
]) {
  const result = prepare(`${prefix}${reference}${following}\n\n[^n]: Note before nested[^other].\n\n[^other]: Other.`);
  if (result.bodyCodeLines) {
    reused++;
    assert.deepEqual([...result.bodyCodeLines], [...collectMarkdownCodeLines(result.body.markdown)], `${prefix}${reference}${following}`);
  } else fallback++;
}
assert.ok(reused > 0 && fallback > 0, 'the corpus must exercise both proven reuse and conservative fallback');
console.log('footnote code-line reuse and structural fallback checks passed', { reused, fallback });
