import assert from 'node:assert/strict';
import { assertHistoryInteraction, assertHistoryCoverage, type HistoryInteractionState, type HistoryInteractionTrace } from './history-interaction-contract';
import { historyAcceptance, inspectHistoryAcceptance } from './history-acceptance-coverage';

const expected: HistoryInteractionState = { text: 'before', ranges: [{ anchor: 1, head: 5 }], mainIndex: 0,
  nativeRanges: [{ anchor: 1, head: 5 }], focus: { kind: 'document', row: null, col: null, from: null, to: null, direction: null, value: null, sourceLine: null },
  scroll: 500, visible: true, shellTop: 0, witness: { id: 1, classes: 'cm-line meo-md-h2', top: 80, height: 30 } };
const trace = (): HistoryInteractionTrace => ({ documents: ['before', 'after'], samples: [1, 0, 0].map(document => {
  const { text, ...sample } = structuredClone(expected); return { ...sample, document };
}) });
const verify = (value: HistoryInteractionTrace, viewport: 'retain' | 'reveal' = 'retain') => assertHistoryInteraction(value, expected,
  { label: 'negative control', allowedTexts: ['before', 'after'], viewport, witness: expected.witness });
verify(trace());
assertHistoryCoverage([]);
assert.throws(() => assertHistoryCoverage(['declared but not executed']), /Every declared/);
assert.deepEqual(inspectHistoryAcceptance(), []);
assert.ok(inspectHistoryAcceptance(['new-document-command']).some(error => error.includes('Missing history acceptance: new-document-command')));
assert.ok(inspectHistoryAcceptance(undefined, [...historyAcceptance, historyAcceptance[0]]).some(error => error.includes('Duplicate')));
assert.ok(inspectHistoryAcceptance(undefined, [{ ...historyAcceptance[0], rule: '' }, ...historyAcceptance.slice(1)]).some(error => error.includes('explicit semantics')));
const reject = (change: (value: HistoryInteractionTrace) => void, message: RegExp) => {
  const value = trace(); change(value); assert.throws(() => verify(value), message);
};
reject(value => value.samples = [], /continuous/);
reject(value => value.documents[0] = 'wrong document', /intermediate/);
reject(value => value.samples.at(-1)!.ranges = [{ anchor: 1, head: 1 }], /logical selection/);
reject(value => value.samples.at(-1)!.nativeRanges = [{ anchor: 1, head: 1 }], /native selection/);
reject(value => value.samples.at(-1)!.focus.kind = 'other', /focus owner/);
reject(value => value.samples.at(-1)!.focus.direction = 'backward', /focus owner/);
reject(value => value.samples.at(-1)!.visible = false, /not visible/);
reject(value => value.samples[1].scroll = 0, /viewport jumped/);
reject(value => value.samples[1].shellTop = -40, /menu shell/);
reject(value => value.samples[1].witness!.id = 2, /presentation/);
reject(value => value.samples[1].witness!.classes = 'cm-line', /presentation/);
reject(value => value.samples[1].witness!.top += 30, /content moved/);
const reversal = trace(); reversal.samples.map((sample, index) => { sample.scroll = [500, 800, 500][index]; });
assert.throws(() => verify(reversal, 'reveal'), /revers/i);
const forward = trace(); forward.samples.forEach((sample, index) => { sample.scroll = [100, 300, 500][index]; }); verify(forward, 'reveal');
console.log('Shared history interaction contract passed: text, logical/native selection, focus, visibility, presentation, shell and transient scroll negative controls');
