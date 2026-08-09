import assert from 'node:assert/strict';
import {
  createDiagnosticSuggestionApplication,
  type DiagnosticSuggestionEffect,
  type DiagnosticSuggestionEffectExecution,
  type DiagnosticSuggestionEffectExecutor,
  type DiagnosticSuggestionInput
} from '../webview/src/application/diagnosticSuggestion';
import { createDiagnosticSuggestionRuntime } from '../webview/src/adapters/diagnosticSuggestionRuntime';

const firstDiagnostic = { from: 2, to: 6, message: 'First unknown word', source: 'spell' } as const;
const secondDiagnostic = { from: 10, to: 15, message: 'Second unknown word', source: 'spell' } as const;

const executed: DiagnosticSuggestionEffect[] = [];
const pending = new Map<number, (input: DiagnosticSuggestionInput | null) => void>();
let disposedExecutors = 0;
const executor: DiagnosticSuggestionEffectExecutor = {
  execute(effect): DiagnosticSuggestionEffectExecution {
    executed.push(effect);
    if (effect.type === 'cancelRequest') {
      for (const settle of pending.values()) settle(null);
      pending.clear();
      return {};
    }
    if (effect.type === 'presentSuggestions') {
      return { completion: Promise.resolve({
        type: 'suggestionsPresented',
        correlationId: effect.correlationId,
        diagnostic: effect.diagnostic
      }) };
    }
    if (effect.type !== 'requestSuggestions') return {};
    return {
      completion: new Promise((resolve) => pending.set(effect.correlationId, resolve))
    };
  },
  dispose() { disposedExecutors += 1; }
};

const application = createDiagnosticSuggestionApplication();
const runtime = createDiagnosticSuggestionRuntime({ application, executor });
runtime.dispatch({ type: 'diagnosticsChanged', diagnostics: [firstDiagnostic, secondDiagnostic] });
assert.deepEqual(executed.slice(0, 2).map((effect) => effect.type), ['cancelRequest', 'hideSuggestions']);

runtime.dispatch({ type: 'suggestionsRequested', diagnostic: firstDiagnostic, anchorId: 1 });
const firstRequest = executed.at(-1);
assert.ok(firstRequest?.type === 'requestSuggestions');
let idle = false;
void runtime.whenIdle().then(() => { idle = true; });
await Promise.resolve();
assert.equal(idle, false, 'whenIdle must wait for the current suggestion request');

runtime.dispatch({ type: 'suggestionsRequested', diagnostic: secondDiagnostic, anchorId: 2 });
const secondRequest = executed.at(-1);
assert.ok(secondRequest?.type === 'requestSuggestions');
assert.notEqual(secondRequest.correlationId, firstRequest.correlationId);
await Promise.resolve();
assert.equal(idle, false, 'a newer request must replace, not wait behind, the old request');

pending.get(secondRequest.correlationId)?.({
  type: 'suggestionsResolved',
  correlationId: secondRequest.correlationId,
  diagnostic: secondDiagnostic,
  suggestions: ['second known word']
});
await runtime.whenIdle();
assert.equal(executed.at(-1)?.type, 'presentSuggestions');
assert.equal(idle, true);

runtime.dispatch({ type: 'diagnosticsChanged', diagnostics: [firstDiagnostic] });
runtime.dispatch({ type: 'suggestionsRequested', diagnostic: firstDiagnostic, anchorId: 3 });
const externalRequest = executed.at(-1);
assert.ok(externalRequest?.type === 'requestSuggestions');
runtime.dispatch({ type: 'externalDocumentPresented' });
await runtime.whenIdle();
assert.deepEqual(executed.slice(-2).map((effect) => effect.type), ['cancelRequest', 'hideSuggestions']);
pending.get(externalRequest.correlationId)?.({
  type: 'suggestionsResolved',
  correlationId: externalRequest.correlationId,
  diagnostic: firstDiagnostic,
  suggestions: ['late external result']
});
await Promise.resolve();
assert.notEqual(executed.at(-1)?.type, 'presentSuggestions');

runtime.dispose();
assert.equal(disposedExecutors, 1);
const effectCountAfterDispose = executed.length;
runtime.dispatch({ type: 'diagnosticsChanged', diagnostics: [firstDiagnostic] });
assert.equal(executed.length, effectCountAfterDispose);
runtime.dispose();
assert.equal(disposedExecutors, 1, 'dispose must be idempotent');

const rejectingApplication = createDiagnosticSuggestionApplication();
const rejectingExecutor: DiagnosticSuggestionEffectExecutor = {
  execute(effect) {
    if (effect.type === 'requestSuggestions') {
      return { completion: Promise.reject(new Error('transport rejected')) };
    }
    return {};
  },
  dispose() {}
};
const rejectingRuntime = createDiagnosticSuggestionRuntime({
  application: rejectingApplication,
  executor: rejectingExecutor
});
rejectingRuntime.dispatch({ type: 'diagnosticsChanged', diagnostics: [firstDiagnostic] });
rejectingRuntime.dispatch({ type: 'suggestionsRequested', diagnostic: firstDiagnostic, anchorId: 4 });
await rejectingRuntime.whenIdle();
assert.equal(rejectingApplication.isIdle(), true, 'rejected execution must restore idle state');
rejectingRuntime.dispose();

const missingPresentationApplication = createDiagnosticSuggestionApplication();
let missingPresentationRequests = 0;
const missingPresentationRuntime = createDiagnosticSuggestionRuntime({
  application: missingPresentationApplication,
  executor: {
    execute(effect) {
      if (effect.type === 'requestSuggestions') {
        missingPresentationRequests += 1;
        return { completion: Promise.resolve({
          type: 'suggestionsResolved', correlationId: effect.correlationId,
          diagnostic: effect.diagnostic, suggestions: ['retryable']
        }) };
      }
      return {};
    },
    dispose() {}
  }
});
missingPresentationRuntime.dispatch({ type: 'diagnosticsChanged', diagnostics: [firstDiagnostic] });
missingPresentationRuntime.dispatch({
  type: 'suggestionsRequested', diagnostic: firstDiagnostic, anchorId: 5
});
await missingPresentationRuntime.whenIdle();
missingPresentationRuntime.dispatch({
  type: 'suggestionsRequested', diagnostic: firstDiagnostic, anchorId: 6
});
assert.equal(missingPresentationRequests, 2, 'missing presentation completion must fail closed and remain retryable');
missingPresentationRuntime.dispose();

console.log('Diagnostic suggestion runtime checks passed');
