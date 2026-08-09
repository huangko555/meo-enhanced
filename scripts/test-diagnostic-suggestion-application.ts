import assert from 'node:assert/strict';
import {
  createDiagnosticSuggestionApplication,
  type DiagnosticSuggestion,
  type DiagnosticSuggestionEffect
} from '../webview/src/application/diagnosticSuggestion';

const diagnostic = {
  from: 4,
  to: 9,
  message: 'Unknown word',
  source: 'spell',
  code: 'unknown'
} as const;
const replacement = { ...diagnostic, message: 'Replacement diagnostic' } as const;
const effectTypes = (effects: readonly DiagnosticSuggestionEffect[]) => effects.map((effect) => effect.type);
const requestEffect = (effects: readonly DiagnosticSuggestionEffect[]) => {
  const effect = effects.find((item) => item.type === 'requestSuggestions');
  assert.ok(effect?.type === 'requestSuggestions');
  return effect;
};

const application = createDiagnosticSuggestionApplication();
assert.equal(application.isIdle(), true);

assert.deepEqual(effectTypes(application.dispatch({ type: 'diagnosticsChanged', diagnostics: [diagnostic] })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.deepEqual(application.dispatch({ type: 'diagnosticClicked', diagnostic, nativeSecondClick: false }), []);
const secondClick = application.dispatch({ type: 'diagnosticClicked', diagnostic, nativeSecondClick: false });
assert.deepEqual(effectTypes(secondClick), ['requestSuggestions']);
const firstRequest = requestEffect(secondClick);
assert.deepEqual(firstRequest.diagnostic, diagnostic);
assert.equal(application.isIdle(), false);

assert.deepEqual(
  application.dispatch({ type: 'diagnosticClicked', diagnostic, nativeSecondClick: true }),
  [],
  'a duplicate request for the same pending diagnostic must be coalesced'
);

const ready = application.dispatch({
  type: 'suggestionsResolved',
  correlationId: firstRequest.correlationId,
  diagnostic,
  suggestions: ['Known word', 'Known-world']
});
assert.deepEqual(ready, [{
  type: 'presentSuggestions',
  correlationId: firstRequest.correlationId,
  from: 4,
  to: 9,
  suggestions: [
    { from: 4, to: 9, text: 'Known word' },
    { from: 4, to: 9, text: 'Known-world' }
  ]
}]);
assert.equal(application.isIdle(), true);
assert.deepEqual(
  application.dispatch({ type: 'suggestionsRequested', diagnostic }),
  [],
  'the currently presented diagnostic must not start a duplicate request'
);
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved',
  correlationId: firstRequest.correlationId,
  diagnostic,
  suggestions: ['late duplicate']
}), []);

application.dispatch({ type: 'diagnosticsChanged', diagnostics: [diagnostic, replacement] });
const staleRequest = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic }));
const replacementRequestEffects = application.dispatch({ type: 'suggestionsRequested', diagnostic: replacement });
assert.deepEqual(effectTypes(replacementRequestEffects), ['cancelRequest', 'requestSuggestions']);
const currentRequest = requestEffect(replacementRequestEffects);
assert.notEqual(currentRequest.correlationId, staleRequest.correlationId);
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved', correlationId: staleRequest.correlationId,
  diagnostic, suggestions: ['stale']
}), []);

assert.deepEqual(application.dispatch({
  type: 'suggestionsFailed', correlationId: currentRequest.correlationId
}), []);
assert.equal(application.isIdle(), true);

const emptyRequest = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic }));
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved', correlationId: emptyRequest.correlationId,
  diagnostic, suggestions: []
}), []);

const invalidated = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic }));
assert.deepEqual(effectTypes(application.dispatch({ type: 'diagnosticsChanged', diagnostics: [replacement] })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved', correlationId: invalidated.correlationId,
  diagnostic, suggestions: ['must not return']
}), []);

const externalRequest = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic: replacement }));
assert.deepEqual(effectTypes(application.dispatch({ type: 'externalDocumentPresented' })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved', correlationId: externalRequest.correlationId,
  diagnostic: replacement, suggestions: ['late external result']
}), []);

application.dispatch({ type: 'diagnosticsChanged', diagnostics: [diagnostic] });
application.dispatch({ type: 'diagnosticClicked', diagnostic, nativeSecondClick: false });
assert.deepEqual(effectTypes(application.dispatch({ type: 'presentationChanged' })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.deepEqual(application.dispatch({ type: 'diagnosticClicked', diagnostic, nativeSecondClick: false }), []);

application.dispatch({ type: 'suggestionsRequested', diagnostic });
assert.deepEqual(effectTypes(application.dispatch({ type: 'dispose' })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.equal(application.isIdle(), true);
assert.deepEqual(application.dispatch({ type: 'suggestionsRequested', diagnostic }), []);

const duplicateRange: DiagnosticSuggestion = {
  from: diagnostic.from,
  to: diagnostic.to,
  message: 'A different identity on the same range'
};
const identity = createDiagnosticSuggestionApplication();
identity.dispatch({ type: 'diagnosticsChanged', diagnostics: [diagnostic, duplicateRange] });
identity.dispatch({ type: 'diagnosticClicked', diagnostic, nativeSecondClick: false });
assert.deepEqual(identity.dispatch({
  type: 'diagnosticClicked', diagnostic: duplicateRange, nativeSecondClick: false
}), [], 'same range with a different diagnostic identity is a first click');
assert.deepEqual(identity.dispatch({
  type: 'suggestionsRequested', diagnostic: replacement
}), [], 'a diagnostic outside the current collection cannot start a request');

const separatorA = { from: 0, to: 1, message: `a\u001fb`, source: 'c' } as const;
const separatorB = { from: 0, to: 1, message: 'a', source: `b\u001fc` } as const;
const collisionSafe = createDiagnosticSuggestionApplication();
collisionSafe.dispatch({ type: 'diagnosticsChanged', diagnostics: [separatorA, separatorB] });
collisionSafe.dispatch({ type: 'diagnosticClicked', diagnostic: separatorA, nativeSecondClick: false });
assert.deepEqual(collisionSafe.dispatch({
  type: 'diagnosticClicked', diagnostic: separatorB, nativeSecondClick: false
}), [], 'control characters in fields must not collide diagnostic identities');

const outer = { from: 0, to: 12, message: 'Outer diagnostic' } as const;
const inner = { from: 3, to: 7, message: 'Inner diagnostic' } as const;
const targeting = createDiagnosticSuggestionApplication();
targeting.dispatch({ type: 'diagnosticsChanged', diagnostics: [outer, inner] });
assert.deepEqual(targeting.resolveDiagnostic(4, null), inner, 'the narrowest diagnostic owns an overlapping point');
assert.deepEqual(
  targeting.resolveDiagnostic(4, { from: 0, to: 12 }),
  outer,
  'an exact selected diagnostic takes precedence while the pointer remains inside it'
);
assert.equal(targeting.resolveDiagnostic(20, null), null);

console.log('Diagnostic suggestion application checks passed');
