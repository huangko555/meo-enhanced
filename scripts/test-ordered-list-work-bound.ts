import assert from 'node:assert/strict';
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import {
  collectOrderedListRenumberChanges,
  orderedListRenumberTransactionFilter
} from '../webview/src/helpers/listMarkers';

type AccessCounts = {
  lineReads: number;
  slices: number;
};

function countedTransaction(transaction: Transaction): { transaction: Transaction; counts: AccessCounts } {
  const counts: AccessCounts = { lineReads: 0, slices: 0 };
  const document = transaction.state.doc;
  const countedDocument = new Proxy(document, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'line' || property === 'lineAt') {
        return (...args: unknown[]) => {
          counts.lineReads += 1;
          return (value as (...values: unknown[]) => unknown).apply(target, args);
        };
      }
      if (property === 'sliceString') {
        return (...args: unknown[]) => {
          counts.slices += 1;
          return (value as (...values: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    }
  });
  const countedState = new Proxy(transaction.state, {
    get(target, property) {
      if (property === 'doc') return countedDocument;
      return Reflect.get(target, property, target);
    }
  });

  return {
    transaction: { state: countedState, startState: transaction.startState, changes: transaction.changes } as Transaction,
    counts
  };
}

function applyAtLine(state: EditorState, lineNumber: number, insert: string): Transaction {
  const line = state.doc.line(lineNumber);
  return state.update({ changes: { from: line.to, insert } });
}

function stateWithFilter(doc: string): EditorState {
  return EditorState.create({ doc, extensions: orderedListRenumberTransactionFilter(() => true) });
}

function boundedNormalizedText(transaction: Transaction): { text: string; normalized: boolean } {
  const filter = transaction.state.facet(EditorState.transactionFilter)[0];
  assert.ok(filter, 'the production ordered-list transaction filter must be installed');
  const filtered = filter(transaction);
  if (!Array.isArray(filtered)) {
    return { text: transaction.state.doc.toString(), normalized: false };
  }
  const normalization = filtered[1] as TransactionSpec;
  return {
    text: transaction.state.update({ changes: normalization.changes, sequential: true }).state.doc.toString(),
    normalized: true
  };
}

function assertEquivalentAndBounded(
  label: string,
  transaction: Transaction,
  maximumReads: number
): void {
  const legacy = collectOrderedListRenumberChanges(transaction.state);
  const { transaction: counted, counts } = countedTransaction(transaction);
  const bounded = boundedNormalizedText(counted);
  const legacyText = transaction.state.update({ changes: legacy }).state.doc.toString();
  assert.equal(bounded.text, legacyText, `${label}: bounded normalization must match the full-document oracle`);
  assert.ok(
    counts.lineReads <= maximumReads,
    `${label}: expected at most ${maximumReads} line reads, received ${counts.lineReads}`
  );
}

const plainLines = Array.from({ length: 50_000 }, (_, index) => `plain ${index + 1}`);
const plainState = stateWithFilter(plainLines.join('\n'));
assertEquivalentAndBounded('50k plain document tail edit', applyAtLine(plainState, 50_000, '!'), 8);
assertEquivalentAndBounded('50k plain document middle edit', applyAtLine(plainState, 25_000, '!'), 8);

const distantListState = stateWithFilter(['1. first', '99. intentionally stale', '', ...plainLines].join('\n'));
const distantPlainChange = applyAtLine(distantListState, distantListState.doc.lines, '!');
const { transaction: countedDistantPlainChange, counts: distantPlainCounts } = countedTransaction(distantPlainChange);
assert.deepEqual(
  boundedNormalizedText(countedDistantPlainChange),
  { text: distantPlainChange.state.doc.toString(), normalized: false },
  'an unrelated plain-text change must not normalize a distant list'
);
assert.ok(
  distantPlainCounts.lineReads <= 8,
  `an unrelated plain-text change read ${distantPlainCounts.lineReads} lines`
);

const orderedLines = Array.from({ length: 50_000 }, (_, index) => `${index + 1}. item ${index + 1}`);
const orderedState = stateWithFilter(orderedLines.join('\n'));
assertEquivalentAndBounded('50k ordered list tail edit', applyAtLine(orderedState, 50_000, '!'), 50_004);
assertEquivalentAndBounded('50k ordered list middle edit', applyAtLine(orderedState, 25_000, '!'), 50_004);

const changedStart = orderedState.update({
  changes: { from: orderedState.doc.line(1).from, to: orderedState.doc.line(1).from + 1, insert: '7' }
});
assertEquivalentAndBounded('ordered-list start change', changedStart, 50_004);

for (const [label, text, spec] of [
  ['split', '1. one\n2. two\n3. three', { from: 5, insert: '\nplain' }],
  ['merge', '1. one\n\n9. two\n10. three', { from: 7, to: 8, insert: '' }],
  ['nested', '1. one\n  9. child\n  10. child two\n2. two', { from: 12, insert: '!' }],
  ['mixed', '- task\n1. one\n2. two\n- [ ] todo\n3. three', { from: 14, insert: '!' }],
  ['paste', '1. one\n2. two\n3. three', { from: 7, insert: '\n3. pasted\n4. pasted two' }],
  ['delete', '1. one\n2. two\n3. three', { from: 7, to: 14, insert: '' }]
] as const) {
  const state = stateWithFilter(text);
  assertEquivalentAndBounded(label, state.update({ changes: spec }), state.doc.lines + 8);
}

const multiChangeState = stateWithFilter('1. one\n2. two\n3. three\n\nplain\n\n1. four\n2. five');
const multiChange = multiChangeState.update({
  changes: [
    { from: multiChangeState.doc.line(2).to, insert: '!' },
    { from: multiChangeState.doc.line(8).to, insert: '!' }
  ]
});
assertEquivalentAndBounded('multiple list changes', multiChange, multiChangeState.doc.lines + 12);

console.log('ordered list work-bound checks passed');
