import assert from 'node:assert/strict';
import {
  Annotation,
  EditorState,
  StateEffect,
  Transaction,
  type ChangeSpec,
  type TransactionSpec
} from '@codemirror/state';
import {
  listMarkerData,
  nextOrderedSequenceNumber,
  orderedListRenumberTransactionFilter
} from '../webview/src/helpers/listMarkers';

type AccessCounts = { lineReads: number; slices: number };
type ListChange = { from: number; to: number; insert: string };

const listLine = /^(\s*)(?:[-+*]|\d+[.)])(?:\s+|$)/;
const twoSpaces = { columns: 2, insert: '  ' };
const fourSpaces = { columns: 4, insert: '    ' };
const tabs = { columns: 4, insert: '\t' };

function stateWithFilter(doc: string): EditorState {
  return EditorState.create({ doc, extensions: orderedListRenumberTransactionFilter(() => true) });
}

function rawChange(state: EditorState, changes: ChangeSpec | readonly ChangeSpec[]): Transaction {
  return state.update({ changes, filter: false, annotations: Transaction.userEvent.of('input.type') });
}

function countedTransaction(transaction: Transaction): { transaction: Transaction; counts: AccessCounts } {
  const counts: AccessCounts = { lineReads: 0, slices: 0 };
  const document = transaction.newDoc;
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
      return property === 'doc' ? countedDocument : Reflect.get(target, property, target);
    }
  });
  return {
    transaction: new Proxy(transaction, {
      get(target, property) {
        if (property === 'newDoc') return countedDocument;
        return property === 'state' ? countedState : Reflect.get(target, property, target);
      }
    }) as Transaction,
    counts
  };
}

/** Independent full-document specification oracle. It deliberately ignores changed ranges. */
function fullDocumentOracle(state: EditorState): ListChange[] {
  const styles = new Map<number, typeof twoSpaces>();
  for (let lineNumber = 1; lineNumber <= state.doc.lines;) {
    const start = lineNumber;
    const texts: string[] = [];
    while (lineNumber <= state.doc.lines) {
      const line = state.doc.line(lineNumber);
      const text = state.doc.sliceString(line.from, line.to);
      if (!listLine.test(text)) break;
      texts.push(text);
      lineNumber += 1;
    }
    if (!texts.length) {
      lineNumber += 1;
      continue;
    }
    const indents = texts.map((text) => listLine.exec(text)?.[1] ?? '');
    const style = indents.some((indent) => indent.includes('\t'))
      ? tabs
      : indents.some(Boolean) && indents.filter(Boolean).every((indent) => indent.length % 4 === 0)
        ? fourSpaces
        : twoSpaces;
    for (let number = start; number < lineNumber; number += 1) styles.set(number, style);
  }

  const changes: ListChange[] = [];
  const counts: Array<number | null> = [];
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const marker = listMarkerData(state.doc.sliceString(line.from, line.to), null, styles.get(lineNumber) ?? twoSpaces);
    if (!marker) {
      counts.length = 0;
      continue;
    }
    const { expected, isAnchor } = nextOrderedSequenceNumber(counts, marker.indentLevel, marker.orderedNumber);
    if (expected === null || isAnchor || marker.orderedNumber === undefined) continue;
    const next = String(expected);
    if (next !== marker.orderedNumber) {
      const from = line.from + marker.leadingWhitespace.length;
      changes.push({ from, to: from + marker.orderedNumber.length, insert: next });
    }
  }
  return changes;
}

function invokeProductionFilter(transaction: Transaction): {
  readonly result: Transaction | readonly TransactionSpec[];
  readonly final: Transaction;
} {
  const filter = transaction.startState.facet(EditorState.transactionFilter)[0];
  assert.ok(filter, 'the production ordered-list transaction filter must be installed on the raw start state');
  const result = filter(transaction);
  if (!Array.isArray(result)) return { result, final: transaction };
  const normalization = result[1] as TransactionSpec;
  return {
    result,
    final: transaction.state.update({ changes: normalization.changes, sequential: true })
  };
}

function assertBoundedEquivalent(label: string, transaction: Transaction, maximumReads: number): void {
  const expected = transaction.state.update({ changes: fullDocumentOracle(transaction.state) }).state;
  const { transaction: counted, counts } = countedTransaction(transaction);
  const actual = invokeProductionFilter(counted).final.state;
  assert.equal(actual.doc.toString(), expected.doc.toString(), `${label}: normalized document diverged from the full specification oracle`);
  assert.ok(counts.lineReads <= maximumReads, `${label}: expected <=${maximumReads} line reads, received ${counts.lineReads}`);
}

function assertFullScanMutantIsRed(transaction: Transaction): void {
  const { transaction: counted, counts } = countedTransaction(transaction);
  const changes = fullDocumentOracle(counted.state);
  const mutated = counted.state.update({ changes }).state.doc.toString();
  const expected = transaction.state.update({ changes: fullDocumentOracle(transaction.state) }).state.doc.toString();
  assert.equal(mutated, expected, 'the deliberate full-scan mutant must preserve old output before the work oracle rejects it');
  assert.ok(counts.lineReads >= 100_000, `full-scan mutant unexpectedly read only ${counts.lineReads} lines`);
}

const plainLines = Array.from({ length: 50_000 }, (_, index) => `plain ${index + 1}`);
const plainState = stateWithFilter(plainLines.join('\n'));
const plainTail = rawChange(plainState, { from: plainState.doc.line(50_000).to, insert: '!' });
assertFullScanMutantIsRed(plainTail);
assertBoundedEquivalent('50k plain tail', plainTail, 8);
assertBoundedEquivalent('50k plain middle', rawChange(plainState, { from: plainState.doc.line(25_000).to, insert: '!' }), 8);

const orderedLines = Array.from({ length: 50_000 }, (_, index) => `${index + 1}. item ${index + 1}`);
const orderedState = stateWithFilter(orderedLines.join('\n'));
const orderedTail = rawChange(orderedState, { from: orderedState.doc.line(50_000).to, insert: '!' });
assertBoundedEquivalent('50k ordered tail', orderedTail, 50_004);
const originalUnshift = Array.prototype.unshift;
let unshifts = 0;
Array.prototype.unshift = function (...items: unknown[]): number {
  unshifts += 1;
  return Reflect.apply(originalUnshift, this, items) as number;
};
try {
  invokeProductionFilter(countedTransaction(orderedTail).transaction);
} finally {
  Array.prototype.unshift = originalUnshift;
}
assert.equal(unshifts, 0, 'ordered-list run collection must not shift a prefix one item at a time');
assertBoundedEquivalent('50k ordered middle', rawChange(orderedState, { from: orderedState.doc.line(25_000).to, insert: '!' }), 50_004);
assertBoundedEquivalent('ordered start', rawChange(orderedState, { from: 0, to: 1, insert: '7' }), 50_004);

for (const [label, text, changes] of [
  ['split', '1. one\n2. two\n3. three', { from: 5, insert: '\nplain' }],
  ['merge', '1. one\n\n9. two\n10. three', { from: 7, to: 8, insert: '' }],
  ['nested', '1. one\n  9. child\n  10. child two\n2. two', { from: 12, insert: '!' }],
  ['mixed', '- task\n1. one\n2. two\n- [ ] todo\n3. three', { from: 14, insert: '!' }],
  ['paste', '1. one\n2. two\n3. three', { from: 7, insert: '\n3. pasted\n4. pasted two' }],
  ['delete', '1. one\n2. two\n3. three', { from: 7, to: 14, insert: '' }]
] as const) {
  const state = stateWithFilter(text);
  assertBoundedEquivalent(label, rawChange(state, changes), state.doc.lines + 8);
}

const multiState = stateWithFilter('1. one\n2. two\n3. three\n\nplain\n\n1. four\n2. five');
assertBoundedEquivalent('multiple changes', rawChange(multiState, [
  { from: multiState.doc.line(2).to, insert: '!' },
  { from: multiState.doc.line(8).to, insert: '!' }
]), multiState.doc.lines + 12);

const mappedEffect = StateEffect.define<{ at: number }>({
  map(value, changes) { return { at: changes.mapPos(value.at) }; }
});
const preservedAnnotation = Annotation.define<string>();
const compositionState = stateWithFilter('1. one\n99. two');
const compositionSpec = {
  changes: { from: 6, insert: '!' },
  selection: { anchor: 7 },
  effects: mappedEffect.of({ at: 8 }),
  annotations: [Transaction.userEvent.of('input.type'), preservedAnnotation.of('kept')],
  filter: false
} as const;
const compositionRaw = compositionState.update(compositionSpec);
const composition = invokeProductionFilter(compositionRaw);
assert.equal(composition.final.state.doc.toString(), '1. one!\n2. two');
assert.equal(composition.final.state.selection.main.head, 7);
const compositionApplied = compositionState.update({ ...compositionSpec, filter: true });
assert.equal(compositionApplied.state.doc.toString(), '1. one!\n2. two');
assert.equal(compositionApplied.state.selection.main.head, 7);
assert.equal(compositionApplied.annotation(preservedAnnotation), 'kept');
assert.deepEqual(
  compositionApplied.effects.filter((effect) => effect.is(mappedEffect)).map((effect) => effect.value),
  [{ at: 8 }],
  'the real transaction filter must preserve opaque mapped effects'
);

const remoteRaw = plainState.update({
  changes: { from: plainState.doc.line(50_000).to, insert: '!' },
  annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  filter: false
});
const remoteCounts = countedTransaction(remoteRaw);
assert.equal(invokeProductionFilter(remoteCounts.transaction).final.state.doc.toString(), remoteRaw.state.doc.toString());
assert.equal(remoteCounts.counts.lineReads, 0, 'remote/no-history changes must bypass list scanning');

console.log('ordered list work-bound checks passed');
