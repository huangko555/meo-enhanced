import assert from 'node:assert/strict';
import type { DiagnosticSuggestionsResult } from '../src/protocol/diagnosticSuggestions';
import {
  createCodeMirrorDiagnosticSuggestionAdapter
} from '../webview/src/editor/diagnosticSuggestionAdapter';

const posted: unknown[] = [];
const presented: unknown[] = [];
let hidden = 0;
let anchorTop = 20;
const adapter = createCodeMirrorDiagnosticSuggestionAdapter({
  view: {
    coordsAtPos: () => ({ left: 10, right: 11, top: anchorTop, bottom: anchorTop + 10 }),
    coordsForChar: () => null
  } as never,
  resolveDiagnostic: () => null,
  postMessage(message) { posted.push(message); },
  presentSuggestions(effect) { presented.push(effect); },
  hideSuggestions() { hidden += 1; }
});

const diagnostic = { from: 1, to: 4, message: 'Unknown word', source: 'spell' } as const;
const execution = adapter.execute({
  type: 'requestSuggestions',
  correlationId: 7,
  anchorId: 1,
  diagnostic
});
assert.equal(posted.length, 1);
const request = posted[0] as { requestId: string };
assert.equal(typeof request.requestId, 'string');

const response: DiagnosticSuggestionsResult = {
  type: 'diagnosticSuggestionsResult',
  requestId: request.requestId,
  from: 1,
  to: 4,
  result: { ok: true, value: { suggestions: ['Known word'] } }
};
assert.equal(adapter.accept(response), true);
assert.deepEqual(await execution.completion, {
  type: 'suggestionsResolved', correlationId: 7, diagnostic, suggestions: ['Known word']
});
assert.equal(adapter.accept(response), false, 'duplicate Transport completion must be rejected');

anchorTop = 40;
adapter.execute({
  type: 'presentSuggestions', correlationId: 7, anchorId: 1, diagnostic, from: 1, to: 4,
  suggestions: [{ from: 1, to: 4, text: 'Known word' }]
});
assert.deepEqual(
  (presented[0] as any).anchor,
  { x: 10, y: 40, bottomY: 50 },
  'presentation must resolve current coordinates instead of retaining request-time pixels'
);
adapter.execute({ type: 'hideSuggestions' });
assert.equal(presented.length, 1);
assert.equal(hidden, 1);

const failed = adapter.execute({
  type: 'requestSuggestions', correlationId: 8, anchorId: 2, diagnostic
});
const failedRequest = posted.at(-1) as { requestId: string };
assert.equal(adapter.accept({
  type: 'diagnosticSuggestionsResult', requestId: failedRequest.requestId,
  from: 1, to: 4,
  result: { ok: false, error: { code: 'operation-failed', message: 'failed' } }
}), true);
assert.deepEqual(await failed.completion, { type: 'suggestionsFailed', correlationId: 8 });

const cancelled = adapter.execute({
  type: 'requestSuggestions', correlationId: 9, anchorId: 3, diagnostic
});
const cancelledRequest = posted.at(-1) as { requestId: string };
adapter.execute({ type: 'cancelRequest' });
assert.equal(await cancelled.completion, null);
assert.equal(adapter.accept({ ...response, requestId: cancelledRequest.requestId }), false);

const replacementDiagnostic = { ...diagnostic, from: 6, to: 9, message: 'Replacement' } as const;
const tableA = adapter.inputFromSelectionRequest(diagnostic, () => ({ x: 10, y: 10, bottomY: 20 }));
assert.equal(tableA.type, 'suggestionsRequested');
const tableAExecution = adapter.execute({
  type: 'requestSuggestions', correlationId: 12, anchorId: tableA.anchorId, diagnostic
});
const tableB = adapter.inputFromSelectionRequest(replacementDiagnostic, () => ({ x: 20, y: 30, bottomY: 40 }));
assert.equal(tableB.type, 'suggestionsRequested');
adapter.execute({ type: 'cancelRequest' });
const tableBExecution = adapter.execute({
  type: 'requestSuggestions', correlationId: 13, anchorId: tableB.anchorId, diagnostic: replacementDiagnostic
});
const tableBRequest = posted.at(-1) as { requestId: string };
adapter.accept({
  type: 'diagnosticSuggestionsResult', requestId: tableBRequest.requestId,
  from: 6, to: 9, result: { ok: true, value: { suggestions: ['Current'] } }
});
assert.equal(await tableAExecution.completion, null);
assert.deepEqual(await tableBExecution.completion, {
  type: 'suggestionsResolved', correlationId: 13,
  diagnostic: replacementDiagnostic, suggestions: ['Current']
});
await adapter.execute({
  type: 'presentSuggestions', correlationId: 13, anchorId: tableB.anchorId,
  diagnostic: replacementDiagnostic, from: 6, to: 9,
  suggestions: [{ from: 6, to: 9, text: 'Current' }]
}).completion;
assert.deepEqual(
  (presented.at(-1) as any).anchor,
  { x: 20, y: 30, bottomY: 40 },
  'replacing a table request must preserve the new request-scoped anchor resolver'
);

adapter.dispose();
assert.equal(adapter.accept(response), false);

let timeoutCallback: (() => void) | null = null;
const timeoutAdapter = createCodeMirrorDiagnosticSuggestionAdapter({
  view: { coordsAtPos: () => null, coordsForChar: () => null } as never,
  resolveDiagnostic: () => null,
  postMessage() {},
  presentSuggestions() {},
  hideSuggestions() {},
  transportOptions: {
    timeoutMs: 5,
    scheduleTimeout(callback) { timeoutCallback = callback; return 1; },
    cancelTimeout() {}
  }
});
const timedOut = timeoutAdapter.execute({
  type: 'requestSuggestions', correlationId: 10, anchorId: 4, diagnostic
});
assert.ok(timeoutCallback);
(timeoutCallback as () => void)();
assert.deepEqual(await timedOut.completion, { type: 'suggestionsFailed', correlationId: 10 });
assert.deepEqual(await timeoutAdapter.execute({
  type: 'presentSuggestions', correlationId: 14, anchorId: 404, diagnostic,
  from: 1, to: 4, suggestions: [{ from: 1, to: 4, text: 'Retry' }]
}).completion, { type: 'suggestionsPresentationFailed', correlationId: 14 });
timeoutAdapter.dispose();

const throwingAdapter = createCodeMirrorDiagnosticSuggestionAdapter({
  view: { coordsAtPos: () => null, coordsForChar: () => null } as never,
  resolveDiagnostic: () => null,
  postMessage() { throw new Error('post failed'); },
  presentSuggestions() {},
  hideSuggestions() {}
});
const thrown = throwingAdapter.execute({
  type: 'requestSuggestions', correlationId: 11, anchorId: 5, diagnostic
});
assert.deepEqual(await thrown.completion, { type: 'suggestionsFailed', correlationId: 11 });
throwingAdapter.dispose();

console.log('Diagnostic suggestion effect adapter checks passed');
