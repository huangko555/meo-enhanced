import assert from 'node:assert/strict';
import { EditorState, StateEffect, Text, Transaction } from '@codemirror/state';
import { liveModeExtensions, setLiveDocumentIdleEffect } from '../webview/src/liveMode';
import { documentLines } from '../webview/src/helpers/documentLines';
import { EditorView, type DecorationSet } from '@codemirror/view';

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

const checkpointText = 'EDIT\n\n' + '**Formatted paragraph**\n\n'.repeat(500);
const mainDecorations = (state: EditorState): DecorationSet => state.facet(EditorView.decorations)
  .filter((value): value is DecorationSet => typeof value !== 'function')
  .sort((left, right) => right.size - left.size)[0];
let checkpointState = EditorState.create({ doc: checkpointText, selection: { anchor: 4 },
  extensions: liveModeExtensions({ largeDocument: true }) });
const beforeInput = mainDecorations(checkpointState);
for (let index = 0; index < 5; index += 1) {
  checkpointState = checkpointState.update({ changes: { from: 4 + index, insert: 'x' },
    selection: { anchor: 5 + index }, annotations: Transaction.userEvent.of('input.type') }).state;
}
checkpointState = checkpointState.update({ changes: { from: 4, to: 9 }, selection: { anchor: 4 },
  annotations: Transaction.userEvent.of('undo') }).state;
assert.equal(checkpointState.doc.toString(), checkpointText);
assert.equal(mainDecorations(checkpointState), beforeInput,
  'undoing plain prose to the exact text and selection must reuse its complete Live presentation');

const unrelatedEffect = StateEffect.define<boolean>();
for (const invalidation of ['selection', 'effect', 'presentation', 'reconfigure', 'syntax', 'external', 'small'] as const) {
  let state = EditorState.create({ doc: checkpointText, selection: { anchor: 4 },
    extensions: liveModeExtensions({ largeDocument: invalidation !== 'small' }) });
  const initial = mainDecorations(state);
  const inserted = invalidation === 'syntax' ? '*' : 'x';
  state = state.update({ changes: { from: 4, insert: inserted }, selection: { anchor: 5 },
    annotations: invalidation === 'external' ? [] : Transaction.userEvent.of('input.type') }).state;
  if (invalidation === 'selection') {
    state = state.update({ selection: { anchor: 0 } }).state;
    state = state.update({ selection: { anchor: 5 } }).state;
  } else if (invalidation === 'effect') {
    state = state.update({ effects: unrelatedEffect.of(true) }).state;
  } else if (invalidation === 'presentation') {
    state = state.update({ effects: setLiveDocumentIdleEffect.of(true) }).state;
  } else if (invalidation === 'reconfigure') {
    state = state.update({ effects: StateEffect.appendConfig.of(EditorState.tabSize.of(8)) }).state;
  }
  state = state.update({ changes: { from: 4, to: 5 }, selection: { anchor: 4 },
    annotations: Transaction.userEvent.of('undo') }).state;
  assert.equal(state.doc.toString(), checkpointText);
  assert.notEqual(mainDecorations(state), initial, `${invalidation}: rebuild instead of restoring an inapplicable checkpoint`);
}
console.log('Live history checkpoints preserve exact text/selection and reject changed presentation contexts');
