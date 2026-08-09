import assert from 'node:assert/strict';
import type { DiagnosticSuggestionsResult } from '../src/protocol/diagnosticSuggestions';
import {
  createCodeMirrorDiagnosticSuggestionAdapter
} from '../webview/src/editor/diagnosticSuggestionAdapter';

const posted: unknown[] = [];
const presented: unknown[] = [];
let hidden = 0;
const adapter = createCodeMirrorDiagnosticSuggestionAdapter({
  view: {} as never,
  resolveDiagnostic: () => null,
  postMessage(message) { posted.push(message); },
  presentSuggestions(effect) { presented.push(effect); },
  hideSuggestions() { hidden += 1; }
});

const diagnostic = { from: 1, to: 4, message: 'Unknown word', source: 'spell' } as const;
const execution = adapter.execute({
  type: 'requestSuggestions',
  correlationId: 7,
  diagnostic,
  anchor: { x: 10, y: 20, bottomY: 30 }
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

adapter.execute({
  type: 'presentSuggestions', from: 1, to: 4,
  anchor: { x: 10, y: 20, bottomY: 30 },
  suggestions: [{ from: 1, to: 4, text: 'Known word' }]
});
adapter.execute({ type: 'hideSuggestions' });
assert.equal(presented.length, 1);
assert.equal(hidden, 1);

const failed = adapter.execute({
  type: 'requestSuggestions', correlationId: 8, diagnostic,
  anchor: { x: 10, y: 20, bottomY: 30 }
});
const failedRequest = posted.at(-1) as { requestId: string };
assert.equal(adapter.accept({
  type: 'diagnosticSuggestionsResult', requestId: failedRequest.requestId,
  from: 1, to: 4,
  result: { ok: false, error: { code: 'operation-failed', message: 'failed' } }
}), true);
assert.deepEqual(await failed.completion, { type: 'suggestionsFailed', correlationId: 8 });

const cancelled = adapter.execute({
  type: 'requestSuggestions', correlationId: 9, diagnostic,
  anchor: { x: 10, y: 20, bottomY: 30 }
});
const cancelledRequest = posted.at(-1) as { requestId: string };
adapter.execute({ type: 'cancelRequest' });
assert.equal(await cancelled.completion, null);
assert.equal(adapter.accept({ ...response, requestId: cancelledRequest.requestId }), false);

adapter.dispose();
assert.equal(adapter.accept(response), false);

let timeoutCallback: (() => void) | null = null;
const timeoutAdapter = createCodeMirrorDiagnosticSuggestionAdapter({
  view: {} as never,
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
  type: 'requestSuggestions', correlationId: 10, diagnostic,
  anchor: { x: 10, y: 20, bottomY: 30 }
});
assert.ok(timeoutCallback);
(timeoutCallback as () => void)();
assert.deepEqual(await timedOut.completion, { type: 'suggestionsFailed', correlationId: 10 });
timeoutAdapter.dispose();

const throwingAdapter = createCodeMirrorDiagnosticSuggestionAdapter({
  view: {} as never,
  resolveDiagnostic: () => null,
  postMessage() { throw new Error('post failed'); },
  presentSuggestions() {},
  hideSuggestions() {}
});
const thrown = throwingAdapter.execute({
  type: 'requestSuggestions', correlationId: 11, diagnostic,
  anchor: { x: 10, y: 20, bottomY: 30 }
});
assert.deepEqual(await thrown.completion, { type: 'suggestionsFailed', correlationId: 11 });
throwingAdapter.dispose();

console.log('Diagnostic suggestion effect adapter checks passed');
