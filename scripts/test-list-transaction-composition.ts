import assert from 'node:assert/strict';
import {
  EditorState,
  StateEffect,
  Transaction,
  type Transaction as CodeMirrorTransaction
} from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { orderedListRenumberTransactionFilter } from '../webview/src/helpers/listMarkers';

type PositionedEffect = {
  readonly label: 'before' | 'between' | 'after';
  readonly at: number;
  readonly assoc: -1 | 1;
};

const positionedEffect = StateEffect.define<PositionedEffect>({
  map(value, changes) {
    return { ...value, at: changes.mapPos(value.at, value.assoc) };
  }
});
const nonPositionedEffect = StateEffect.define<string>();

function positionedValues(transaction: CodeMirrorTransaction): PositionedEffect[] {
  return transaction.effects
    .filter((effect) => effect.is(positionedEffect))
    .map((effect) => effect.value);
}

function consumedPositions(transaction: CodeMirrorTransaction): number[] {
  return positionedValues(transaction).map((effect) => (
    transaction.changes.mapPos(effect.at, effect.assoc)
  ));
}

function state(text: string, shouldNormalize: () => boolean = () => true): EditorState {
  return EditorState.create({
    doc: text,
    extensions: orderedListRenumberTransactionFilter(shouldNormalize)
  });
}

const zero = state('1. a\n2. b').update({
  changes: { from: 4, insert: 'x' },
  selection: { anchor: 5 },
  effects: positionedEffect.of({ label: 'after', at: 5, assoc: 1 }),
  annotations: isolateHistory.of('before')
});
assert.equal(zero.newDoc.toString(), '1. ax\n2. b');
assert.equal(zero.newSelection.main.head, 5);
assert.deepEqual(positionedValues(zero), [{ label: 'after', at: 5, assoc: 1 }]);
assert.deepEqual(consumedPositions(zero), [6]);
assert.equal(zero.annotation(isolateHistory), 'before');

const one = state('1. a\n99. b').update({
  changes: { from: 4, insert: 'x' },
  selection: { anchor: 11 },
  effects: positionedEffect.of({ label: 'after', at: 10, assoc: 1 }),
  annotations: [
    Transaction.userEvent.of('input.type'),
    Transaction.addToHistory.of(true),
    isolateHistory.of('after')
  ],
  scrollIntoView: true
});
assert.equal(one.newDoc.toString(), '1. ax\n2. b');
assert.equal(one.newSelection.main.head, 10);
assert.deepEqual(positionedValues(one), [{ label: 'after', at: 10, assoc: 1 }]);
assert.deepEqual(consumedPositions(one), [10]);
assert.equal(one.isUserEvent('input.type'), true);
assert.equal(one.annotation(Transaction.addToHistory), true);
assert.equal(one.annotation(isolateHistory), 'after');
assert.equal(one.scrollIntoView, true);

const two = state('1. a\n99. b\n999. c\n| - |').update({
  changes: [
    { from: 4, insert: 'x' },
    { from: 23, insert: '!' }
  ],
  selection: { anchor: 25 },
  effects: [
    positionedEffect.of({ label: 'before', at: 0, assoc: 1 }),
    positionedEffect.of({ label: 'between', at: 10, assoc: 1 }),
    positionedEffect.of({ label: 'after', at: 18, assoc: 1 }),
    nonPositionedEffect.of('preserved')
  ],
  annotations: [
    Transaction.userEvent.of('input.paste'),
    Transaction.addToHistory.of(true),
    Transaction.remote.of(true),
    Transaction.time.of(123_456),
    isolateHistory.of('full')
  ]
});
assert.equal(two.newDoc.toString(), '1. ax\n2. b\n3. c\n| - |!');
assert.equal(two.newSelection.main.head, 22);
assert.deepEqual(positionedValues(two), [
  { label: 'before', at: 0, assoc: 1 },
  { label: 'between', at: 10, assoc: 1 },
  { label: 'after', at: 18, assoc: 1 }
]);
assert.deepEqual(consumedPositions(two), [0, 10, 16]);
assert.deepEqual(
  two.effects.filter((effect) => effect.is(nonPositionedEffect)).map((effect) => effect.value),
  ['preserved']
);
assert.equal(two.isUserEvent('input.paste'), true);
assert.equal(two.annotation(Transaction.addToHistory), true);
assert.equal(two.annotation(Transaction.remote), true);
assert.equal(two.annotation(Transaction.time), 123_456);
assert.equal(two.annotation(isolateHistory), 'full');

let normalizeExternal = false;
const external = state('1. a\n99. b', () => normalizeExternal).update({
  changes: { from: 4, insert: 'x' },
  selection: { anchor: 5 },
  effects: positionedEffect.of({ label: 'after', at: 10, assoc: 1 }),
  annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)]
});
assert.equal(external.newDoc.toString(), '1. ax\n99. b');
assert.equal(external.newSelection.main.head, 5);
assert.deepEqual(positionedValues(external), [{ label: 'after', at: 10, assoc: 1 }]);
assert.deepEqual(consumedPositions(external), [11]);
assert.equal(external.annotation(Transaction.addToHistory), false);
assert.equal(external.annotation(Transaction.remote), true);

normalizeExternal = true;
const noHistory = external.state.update({
  changes: { from: 5, insert: '!' },
  annotations: Transaction.addToHistory.of(false)
});
assert.equal(noHistory.newDoc.toString(), '1. ax!\n99. b');

console.log('list transaction composition checks passed');
