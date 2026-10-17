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

const decorationShape = (set: DecorationSet) => {
  const ranges: unknown[] = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    const spec = cursor.value.spec;
    ranges.push([cursor.from, cursor.to, spec.class, spec.attributes, spec.block, spec.widget?.constructor.name]);
  }
  return ranges;
};
const prosePrefix = '**Prefix formatting**\n\n' + 'Ordinary filler.\n\n'.repeat(100);
for (const paragraph of ['Plain prose', '中文正文', 'NATIVE_EDIT_TARGET', 'Sentence with punctuation.', 'Two lines\nPlain second line']) {
  const text = prosePrefix + paragraph;
  for (const operation of ['insert', 'delete', 'space'] as const) {
    const from = operation === 'delete'
      ? prosePrefix.length + paragraph.search(/[\p{L}\p{N}][^\p{L}\p{N}]*$/u) : text.length;
    const to = operation === 'delete' ? from + 1 : from;
    const insert = operation === 'delete' ? '' : operation === 'space' ? ' ' : 'x';
    const state = EditorState.create({ doc: text, selection: { anchor: to }, extensions: liveModeExtensions({ largeDocument: true }) });
    const next = state.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length },
      annotations: Transaction.userEvent.of('input.type') }).state;
    const fresh = EditorState.create({ doc: next.doc, selection: next.selection, extensions: liveModeExtensions({ largeDocument: true }) });
    assert.deepEqual(decorationShape(mainDecorations(next)), decorationShape(mainDecorations(fresh)),
      `${paragraph}/${operation}: the input frame must match a fresh authoritative presentation`);
    const positioned = next.update({ selection: { anchor: next.selection.main.head - 1 } }).state;
    assert.equal(mainDecorations(positioned), mainDecorations(next), 'same-line plain caret navigation must reuse the full presentation');
  }
}
for (const paragraph of ['plain $raw', 'plain #tag', 'plain file:///tmp/example', '[^unclosed', '<div>unclosed', 'plain | table', 'x'.repeat(4_100)]) {
  const text = prosePrefix + paragraph;
  const state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: liveModeExtensions({ largeDocument: true }) });
  const next = state.update({ changes: { from: text.length, insert: 'x' }, selection: { anchor: text.length + 1 },
    annotations: Transaction.userEvent.of('input.type') }).state;
  assert.ok(mainDecorations(next).size < mainDecorations(state).size,
    'raw helper syntax and oversized paragraphs must keep the bounded fallback path');
}
{
  const text = prosePrefix + 'Plain middle paragraph.\n\n**Later formatting**\n\n[local](sample.md)\n\n$$\nx^2\n$$';
  const state = EditorState.create({ doc: text, selection: { anchor: prosePrefix.length + 2 },
    extensions: liveModeExtensions({ largeDocument: true }) });
  const next = state.update({ selection: { anchor: prosePrefix.length + 3 } }).state;
  const fresh = EditorState.create({ doc: next.doc, selection: next.selection,
    extensions: liveModeExtensions({ largeDocument: true }) });
  assert.equal(mainDecorations(next), mainDecorations(state), 'plain caret navigation must preserve later rich blocks');
  assert.deepEqual(decorationShape(mainDecorations(next)), decorationShape(mainDecorations(fresh)),
    'middle paragraph caret navigation must match a fresh authoritative presentation');
}
console.log('Plain prose projections match full builds; raw syntax and oversized paragraphs retain conservative refresh');
