import { EditorState } from '@codemirror/state';
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

console.log('ordered list nesting renumber checks passed');
