import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { prepareMarkdownWithFootnotes } from '../src/export/footnotes';
import { collectMarkdownCodeLines, inspectMarkdownCodeLines } from '../src/export/markdownCodeLines';
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
  assert.equal(wholeScans, 1, 'independent footnote removal and inline-only rewriting must share one global code scan');
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

// Removing a complete paragraph between indented blocks can merge their blank
// lines into code. Root alignment alone is insufficient proof of safe reuse.
const joiningCode = '    first\n\nParagraph.\n\n    second';
assert.equal(inspectMarkdownCodeLines(joiningCode).withoutLines(new Set([2])), null);
assert.equal(inspectMarkdownCodeLines('Paragraph before.\nNot independent.').withoutLines(new Set([1])), null);

const blocks = ['Paragraph\ncontinued.', '```js\ncode\n```', '    indented\n    code', '> quote\n> next',
  '- one\n  two\n\n- three', '| A | B |\n| - | - |\n| x | y |', '<div>\nhtml\n</div>', '[ref]: /somewhere',
  '[^n]: note\n\n    continued', 'Title\n---', '~~~\nliteral\n~~~', '<script>\nraw\n</script>',
  '<span>\n\ncontent\n\n</span>'];
let removalChecks = 0, removalFallbacks = 0;
for (const left of blocks) for (const middle of blocks) for (const right of ['After.', '```\ncode\n```', '    after', '- after', '---', '[ref]: /new']) {
  const markdown = `${left}\n\n${middle}\n\n${right}`, lines = markdown.split('\n');
  const inspection = inspectMarkdownCodeLines(markdown);
  for (let from = 0; from < lines.length; from++) for (let to = from + 1; to <= lines.length; to++) {
    const removed = new Set(Array.from({ length: to - from }, (_, offset) => from + offset));
    const projected = inspection.withoutLines(removed);
    if (!projected) { removalFallbacks++; continue; }
    const body = lines.filter((_, index) => !removed.has(index)).join('\n');
    assert.deepEqual([...projected.codeLines], [...collectMarkdownCodeLines(body)], JSON.stringify({ left, middle, right, from, to }));
    removalChecks++;
  }
}
assert.ok(removalChecks > 1_000 && removalFallbacks > removalChecks);
let multipleCuts = 0;
for (const newline of ['\n', '\r\n']) for (const first of blocks) for (const second of blocks) {
  const parts = [first, 'Paragraph to remove.', second, '[^n]: Note.'];
  const lines = parts.flatMap((part, index) => [...part.split('\n'), ...(index + 1 < parts.length ? ['', ''] : [])]);
  const starts: number[] = [];
  for (let index = 0, line = 0; index < parts.length; index++) { starts.push(line); line += parts[index]!.split('\n').length + 2; }
  const inspection = inspectMarkdownCodeLines(lines.join(newline));
  for (let mask = 1; mask < 16; mask++) {
    const removed = new Set<number>();
    for (let part = 0; part < parts.length; part++) if (mask & 1 << part) {
      for (let line = starts[part]!; line < starts[part]! + parts[part]!.split('\n').length; line++) removed.add(line);
    }
    const projected = inspection.withoutLines(removed);
    if (!projected) continue;
    assert.deepEqual([...projected.codeLines], [...collectMarkdownCodeLines(lines.filter((_, index) => !removed.has(index)).join('\n'))]);
    multipleCuts++;
  }
}
assert.ok(multipleCuts > 1_000, 'multiple cuts must account for all removed lines and both line endings');
console.log('footnote code-line reuse and structural fallback checks passed', { reused, fallback, removalChecks, removalFallbacks, multipleCuts });
