import assert from 'node:assert/strict';
import {
  Annotation,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Transaction as CodeMirrorTransaction,
  type TransactionSpec
} from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { orderedListRenumberTransactionFilter } from '../webview/src/helpers/listMarkers';
import {
  isLiveInputNestedProjection,
  liveInputDerivedWorkExtensions,
  markLiveInputNestedProjection,
  shouldDeferLiveInputDerivedWork
} from '../webview/src/editor/liveInputDerivedWork';

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
const opaqueConsumerAnnotation = Annotation.define<{ readonly consumer: string }>();

function positionedValues(transaction: CodeMirrorTransaction): PositionedEffect[] {
  return transaction.effects
    .filter((effect) => effect.is(positionedEffect))
    .map((effect) => effect.value);
}

function state(text: string, shouldNormalize: () => boolean = () => true): EditorState {
  return EditorState.create({
    doc: text,
    extensions: orderedListRenumberTransactionFilter(shouldNormalize)
  });
}

// Filters must not construct provisional fields before transaction extenders run.
for (const [doc, from, expected] of [
  ['# Heading', 9, '# Headingx'],
  ['1. a\n2. b', 4, '1. ax\n2. b'],
  ['1. a\n99. b', 4, '1. ax\n2. b']
] as const) {
  let updates = 0;
  const extended = StateEffect.define<boolean>();
  const observer = StateField.define<boolean>({
    create: () => false,
    update(_value, transaction) {
      updates += 1;
      return transaction.effects.some((effect) => effect.is(extended));
    }
  });
  const initial = EditorState.create({
    doc,
    extensions: [
      orderedListRenumberTransactionFilter(() => true),
      observer,
      EditorState.transactionExtender.of(() => ({ effects: extended.of(true) }))
    ]
  });
  const transaction = initial.update({ changes: { from, insert: 'x' } });
  assert.equal(updates, 0, `list filter must leave fields lazy: ${doc}`);
  assert.equal(transaction.newDoc.toString(), expected);
  assert.equal(transaction.state.field(observer), true);
  assert.equal(updates, 1, 'fields should update only for the final extended transaction');
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
assert.deepEqual(positionedValues(one), [{ label: 'after', at: 9, assoc: 1 }]);
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
  { label: 'between', at: 9, assoc: 1 },
  { label: 'after', at: 15, assoc: 1 }
]);
assert.deepEqual(
  two.effects.filter((effect) => effect.is(nonPositionedEffect)).map((effect) => effect.value),
  ['preserved']
);
assert.equal(two.isUserEvent('input.paste'), true);
assert.equal(two.annotation(Transaction.addToHistory), true);
assert.equal(two.annotation(Transaction.remote), true);
assert.equal(two.annotation(Transaction.time), 123_456);
assert.equal(two.annotation(isolateHistory), 'full');

for (const consumer of ['mermaid', 'latex']) {
  const nestedState = EditorState.create({
    doc: '1. a\n99. b',
    extensions: [
      orderedListRenumberTransactionFilter(() => true),
      ...liveInputDerivedWorkExtensions()
    ]
  });
  const nestedProjection = nestedState.update({
    changes: { from: 4, insert: 'x' },
    selection: { anchor: 5 },
    annotations: [
      Transaction.userEvent.of('input.type'),
      markLiveInputNestedProjection(),
      opaqueConsumerAnnotation.of({ consumer })
    ]
  });
  assert.equal(nestedProjection.newDoc.toString(), '1. ax\n2. b');
  assert.equal(nestedProjection.newSelection.main.head, 5);
  assert.equal(
    isLiveInputNestedProjection(nestedProjection),
    true,
    `${consumer} nested provenance must survive ordered-list normalization`
  );
  assert.equal(
    shouldDeferLiveInputDerivedWork(nestedProjection),
    true,
    `${consumer} nested input must keep the production derived-work barrier`
  );
  assert.deepEqual(
    nestedProjection.annotation(opaqueConsumerAnnotation),
    { consumer },
    `${consumer} opaque annotations must survive without a list-owned registry`
  );
}

const publicOnlyStart = EditorState.create({
  doc: '1. a\n99. b',
  extensions: liveInputDerivedWorkExtensions()
});
const publicOnlyInput = publicOnlyStart.update({
  changes: { from: 4, insert: 'x' },
  annotations: [
    Transaction.userEvent.of('input.type'),
    markLiveInputNestedProjection(),
    opaqueConsumerAnnotation.of({ consumer: 'public-interface' })
  ]
});
const publicTransactionOwnKeys = new Set<PropertyKey>([
  'startState',
  'changes',
  'selection',
  'effects',
  'scrollIntoView'
]);
const publicOnlyTransaction = new Proxy(publicOnlyInput, {
  ownKeys(target) {
    return Reflect.ownKeys(target).filter((key) => publicTransactionOwnKeys.has(key));
  }
});
const filterState = EditorState.create({
  doc: publicOnlyStart.doc,
  extensions: orderedListRenumberTransactionFilter(() => true)
});
const publicFilter = filterState.facet(EditorState.transactionFilter)[0];
assert.ok(publicFilter, 'the production ordered-list filter must be installed');
const publicFilteredSpec = publicFilter(publicOnlyTransaction);
const publicFilteredSpecs: readonly TransactionSpec[] = Array.isArray(publicFilteredSpec)
  ? publicFilteredSpec
  : [publicFilteredSpec];
const publicFiltered = publicOnlyStart.update(...publicFilteredSpecs);
assert.equal(publicFiltered.newDoc.toString(), '1. ax\n2. b');
assert.equal(
  isLiveInputNestedProjection(publicFiltered),
  true,
  'normalization must use only the public Transaction Interface to preserve nested provenance'
);
assert.equal(shouldDeferLiveInputDerivedWork(publicFiltered), true);
assert.deepEqual(
  publicFiltered.annotation(opaqueConsumerAnnotation),
  { consumer: 'public-interface' },
  'opaque annotations must not depend on Transaction own-key enumeration'
);

const filterDisabled = state('1. a\n99. b').update({
  changes: { from: 4, insert: 'x' },
  annotations: opaqueConsumerAnnotation.of({ consumer: 'filter-false' }),
  filter: false
});
assert.equal(filterDisabled.newDoc.toString(), '1. ax\n99. b');
assert.deepEqual(
  filterDisabled.annotation(opaqueConsumerAnnotation),
  { consumer: 'filter-false' },
  'CodeMirror filter=false must bypass normalization without changing opaque semantics'
);

const throwingState = state('1. a\n99. b', () => {
  throw new Error('controlled normalization predicate failure');
});
assert.throws(
  () => throwingState.update({ changes: { from: 4, insert: 'x' } }),
  /controlled normalization predicate failure/,
  'a synchronous filter failure must reject the transaction instead of publishing a partial document'
);
assert.equal(throwingState.doc.toString(), '1. a\n99. b');

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
assert.equal(external.annotation(Transaction.addToHistory), false);
assert.equal(external.annotation(Transaction.remote), true);

normalizeExternal = true;
const noHistory = external.state.update({
  changes: { from: 5, insert: '!' },
  annotations: Transaction.addToHistory.of(false)
});
assert.equal(noHistory.newDoc.toString(), '1. ax!\n99. b');

console.log('list transaction composition checks passed');
