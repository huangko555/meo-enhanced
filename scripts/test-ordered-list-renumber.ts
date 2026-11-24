import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import assert from 'node:assert/strict';
import { orderedListRenumberTransactionFilter, listMarkerData, continuedListMarker } from '../webview/src/helpers/listMarkers';
import { hasMarkdownListPrefix, readMarkdownListPrefix } from '../src/foundation/markdownListPrefix';

for (const { source, offset, body, status } of [
  { source: '  -\t [X]\t body', offset: 0, body: 'body', status: 'X' },
  { source: '> 12)  [ ]   body', offset: 2, body: 'body', status: ' ' },
  { source: '\t+ [~] body', offset: 0, body: '[~] body', status: undefined },
  { source: '001. body', offset: 0, body: 'body', status: undefined }
]) {
  const prefix = readMarkdownListPrefix(source, offset)!;
  assert.ok(prefix);
  assert.equal(source.slice(prefix.toOffset), body);
  assert.equal(prefix.taskMarker, status);
  assert.equal(source.slice(prefix.fromOffset, prefix.markerEndOffset), prefix.bullet ?? `${prefix.orderedNumber}${prefix.orderedSuffix}`);
  if (prefix.taskBracketStart !== undefined) assert.equal(source[prefix.taskBracketStart], '[');
}
for (const source of ['-word', '1.word', '[x] body', '> - body']) {
  assert.equal(hasMarkdownListPrefix(source), false, source);
  assert.equal(readMarkdownListPrefix(source), null, source);
}

for (const prefix of ['- ', '+ ', '* ', '1. ', '1) ']) {
  for (const [marker, status] of [[' ', 'todo'], ['x', 'done'], ['X', 'done']]) {
    const text = `${prefix}[${marker}] task`;
    const parsed = listMarkerData(text)!;
    assert.equal(parsed.isTask, true, text);
    assert.equal(parsed.taskStatus, status, text);
    assert.equal(text.slice(parsed.toOffset), 'task', text);
    assert.equal(continuedListMarker(text), `${prefix.startsWith('1') ? '2' + prefix.slice(1) : prefix}[ ] `, text);
  }
  for (const marker of ['~', '-', '/']) {
    const text = `${prefix}[${marker}] literal`;
    const parsed = listMarkerData(text)!;
    assert.equal(parsed.isTask, false, text);
    assert.equal(parsed.taskStatus, undefined, text);
    assert.equal(text.slice(parsed.toOffset), `[${marker}] literal`, text);
    assert.equal(continuedListMarker(text), prefix.startsWith('1') ? '2' + prefix.slice(1) : prefix, text);
  }
}

const state = EditorState.create({
  doc: '1. First\n99. Second\n3. Third\n  4. Nested first\n  5. Nested second',
  extensions: orderedListRenumberTransactionFilter(() => true)
});
const nestedMarker = listMarkerData('  4. Nested first');
if (nestedMarker?.indentLevel !== 1) {
  throw new Error(`Expected the indented item to be at level 1, received ${nestedMarker?.indentLevel}`);
}
const firstLine = state.doc.line(1);
const renumbered = state.update({ changes: { from: firstLine.to, insert: '!' } }).state.doc.toString();
const expected = '1. First!\n2. Second\n3. Third\n  4. Nested first\n  5. Nested second';

if (renumbered !== expected) {
  throw new Error(`Nested ordered lists must preserve an explicit start. Received:\n${renumbered}`);
}

// `|` marks the edited position.
for (const [source, insert, expected] of [
  ['```text\n10. A|\n20. B\n30. C\n```', '!', '```text\n10. A!\n20. B\n30. C\n```'],
  ['```text\n10. A\n20. B|\n```', '\n7. C', '```text\n10. A\n20. B\n7. C\n```'],
  ['```|\n10. A\n20. B\n```', 'text', '```text\n10. A\n20. B\n```'],
  ['```text\n10. A\n20. B\n```|', '\n', '```text\n10. A\n20. B\n```\n'],
  ['~~~\n10. A|\n20. B\n~~~', '!', '~~~\n10. A!\n20. B\n~~~'],
  ['```\n10. A|\n20. B', '!', '```\n10. A!\n20. B'],
  ['```\n10. A|', '\n20. B', '```\n10. A\n20. B'],
  ['p\n\n    10. A|\n    20. B\n', '!', 'p\n\n    10. A!\n    20. B\n'],
  ['- ```\n  10. A|\n  20. B\n  ```', '!', '- ```\n  10. A!\n  20. B\n  ```'],
  ['1. a\n   ```\n   10. A|\n   20. B\n   ```\n2. b', '!', '1. a\n   ```\n   10. A!\n   20. B\n   ```\n2. b'],
  ['|', '```text\n10. A\n20. B\n```\n1. a\n1. b', '```text\n10. A\n20. B\n```\n1. a\n2. b'],
  ['|10. A\n20. B\n30. C', '```\n', '```\n10. A\n20. B\n30. C'],
  ['``|\n10. A\n20. B\n30. C', '`', '```\n10. A\n20. B\n30. C'],
  ['|', '    10. A\n    20. B\n    30. C', '    10. A\n    20. B\n    30. C'],
  ['|', '```text\n' + '10. A\n'.repeat(6_000) + '```', '```text\n' + '10. A\n'.repeat(6_000) + '```'],
  ['1. a|\n1. b\n1. c', '!', '1. a!\n2. b\n3. c'],
  ['```\n10. A\n20. B\n```\n1. a|\n1. b', '!', '```\n10. A\n20. B\n```\n1. a!\n2. b'],
  ['1. a\n    5. b|\n    9. c\n9. d', '!', '1. a\n    5. b!\n    6. c\n2. d']
] as const) {
  const at = source.indexOf('|');
  const doc = source.replace('|', '');
  const before = EditorState.create({ doc, extensions: [markdown(), orderedListRenumberTransactionFilter(() => true)] });
  ensureSyntaxTree(before, doc.length, 5_000);
  assert.equal(before.update({ changes: { from: at, insert } }).newDoc.toString(), expected, source);
}

console.log('ordered list nesting renumber checks passed');
