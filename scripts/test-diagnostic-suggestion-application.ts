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
const anchor = { x: 120, y: 48, bottomY: 66 } as const;
const effectTypes = (effects: readonly DiagnosticSuggestionEffect[]) => effects.map((effect) => effect.type);
const requestEffect = (effects: readonly DiagnosticSuggestionEffect[]) => {
  const effect = effects.find((item) => item.type === 'requestSuggestions');
  assert.ok(effect?.type === 'requestSuggestions');
  return effect;
};

const application = createDiagnosticSuggestionApplication();
assert.deepEqual(application.getState(), {
  lifecycle: 'active', diagnostics: [], lastClickKey: null, pending: null, presentedDiagnosticKey: null
});

assert.deepEqual(effectTypes(application.dispatch({ type: 'diagnosticsChanged', diagnostics: [diagnostic] })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.deepEqual(application.dispatch({ type: 'diagnosticClicked', diagnostic, anchor, nativeSecondClick: false }), []);
const secondClick = application.dispatch({ type: 'diagnosticClicked', diagnostic, anchor, nativeSecondClick: false });
assert.deepEqual(effectTypes(secondClick), ['requestSuggestions']);
const firstRequest = requestEffect(secondClick);
assert.deepEqual(firstRequest.diagnostic, diagnostic);
assert.deepEqual(firstRequest.anchor, anchor);

assert.deepEqual(
  application.dispatch({ type: 'diagnosticClicked', diagnostic, anchor, nativeSecondClick: true }),
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
  from: 4,
  to: 9,
  anchor,
  suggestions: [
    { from: 4, to: 9, text: 'Known word' },
    { from: 4, to: 9, text: 'Known-world' }
  ]
}]);
assert.equal(application.getState().pending, null);
assert.deepEqual(
  application.dispatch({ type: 'suggestionsRequested', diagnostic, anchor }),
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
const staleRequest = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic, anchor }));
const replacementRequestEffects = application.dispatch({ type: 'suggestionsRequested', diagnostic: replacement, anchor });
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
assert.equal(application.getState().pending, null);

const emptyRequest = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic, anchor }));
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved', correlationId: emptyRequest.correlationId,
  diagnostic, suggestions: []
}), []);

const invalidated = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic, anchor }));
assert.deepEqual(effectTypes(application.dispatch({ type: 'diagnosticsChanged', diagnostics: [replacement] })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved', correlationId: invalidated.correlationId,
  diagnostic, suggestions: ['must not return']
}), []);

const externalRequest = requestEffect(application.dispatch({ type: 'suggestionsRequested', diagnostic: replacement, anchor }));
assert.deepEqual(effectTypes(application.dispatch({ type: 'externalDocumentPresented' })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.deepEqual(application.dispatch({
  type: 'suggestionsResolved', correlationId: externalRequest.correlationId,
  diagnostic: replacement, suggestions: ['late external result']
}), []);

application.dispatch({ type: 'diagnosticsChanged', diagnostics: [diagnostic] });
application.dispatch({ type: 'diagnosticClicked', diagnostic, anchor, nativeSecondClick: false });
assert.deepEqual(effectTypes(application.dispatch({ type: 'presentationChanged' })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.equal(application.getState().lastClickKey, null);

application.dispatch({ type: 'suggestionsRequested', diagnostic, anchor });
assert.deepEqual(effectTypes(application.dispatch({ type: 'dispose' })), [
  'cancelRequest', 'hideSuggestions'
]);
assert.equal(application.getState().lifecycle, 'disposed');
assert.deepEqual(application.dispatch({ type: 'suggestionsRequested', diagnostic, anchor }), []);

const duplicateRange: DiagnosticSuggestion = {
  from: diagnostic.from,
  to: diagnostic.to,
  message: 'A different identity on the same range'
};
const identity = createDiagnosticSuggestionApplication();
identity.dispatch({ type: 'diagnosticsChanged', diagnostics: [diagnostic, duplicateRange] });
identity.dispatch({ type: 'diagnosticClicked', diagnostic, anchor, nativeSecondClick: false });
assert.deepEqual(identity.dispatch({
  type: 'diagnosticClicked', diagnostic: duplicateRange, anchor, nativeSecondClick: false
}), [], 'same range with a different diagnostic identity is a first click');
assert.deepEqual(identity.dispatch({
  type: 'suggestionsRequested', diagnostic: replacement, anchor
}), [], 'a diagnostic outside the current collection cannot start a request');

console.log('Diagnostic suggestion application checks passed');
