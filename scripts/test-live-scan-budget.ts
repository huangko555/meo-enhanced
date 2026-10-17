import assert from 'node:assert/strict';
import { EditorState, Text, Transaction } from '@codemirror/state';
import { liveModeExtensions } from '../webview/src/liveMode';
import { documentLines } from '../webview/src/helpers/documentLines';

// Cover empty/final lines, text-tree branch boundaries and UTF-16 positions.
for (const text of ['', '\n', 'a\n', '\n\n', '汉字\n😀\nlast',
  Array.from({ length: 4_097 }, (_, index) => index % 7 ? `line ${index} 😀` : '').join('\n')]) {
  const document = EditorState.create({ doc: text }).doc;
  const actual = [...documentLines(document)];
  assert.equal(actual.length, document.lines);
  for (const line of actual) {
    const expected = document.line(line.number);
    assert.deepEqual(line, { from: expected.from, to: expected.to, number: expected.number,
      text: expected.text, length: expected.length });
  }
}

// A plain document still exercises Live's HTML, list, table, tag and conflict
// fallbacks. Count random line lookups rather than imposing machine-speed limits.
const original = 'Plain paragraph with ordinary words.\n\n'.repeat(2_500) + 'EDIT';
const readLine = Text.prototype.line;
let lookups = 0;
Text.prototype.line = function(number: number) {
  lookups += 1;
  return readLine.call(this, number);
};
try {
  let state = EditorState.create({
    doc: original,
    extensions: liveModeExtensions({ largeDocument: true })
  });
  state = state.update({
    changes: { from: original.length, insert: 'x' },
    annotations: Transaction.userEvent.of('input.type')
  }).state;
  lookups = 0;
  state = state.update({
    changes: { from: original.length, to: original.length + 1 },
    annotations: Transaction.userEvent.of('undo')
  }).state;
  assert.equal(state.doc.toString(), original, 'history must restore the exact text');
  console.log(`Live plain-text undo: ${lookups} random line lookups for ${state.doc.lines} lines`);
  assert.ok(lookups < state.doc.lines * 2,
    'whole-document fallbacks must traverse text sequentially instead of repeatedly seeking every line');
} finally {
  Text.prototype.line = readLine;
}
