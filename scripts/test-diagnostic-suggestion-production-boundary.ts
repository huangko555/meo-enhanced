import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editorSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');

for (const [factory, expected] of [
  ['createDiagnosticSuggestionApplication', 1],
  ['createDiagnosticSuggestionRuntime', 1],
  ['createCodeMirrorDiagnosticSuggestionAdapter', 1]
] as const) {
  assert.equal(
    [...editorSource.matchAll(new RegExp(`\\b${factory}\\(`, 'g'))].length,
    expected,
    `production Editor Bootstrap must create ${factory} exactly once`
  );
}

for (const legacyOwner of [
  'lastDiagnosticClick',
  'pendingDiagnosticSuggestionRequest',
  'onRequestDiagnosticSuggestions',
  'showDiagnosticSuggestions',
  'clearDiagnosticSuggestionState',
  'requestDiagnosticSuggestionsFor'
]) {
  assert.equal(editorSource.includes(legacyOwner), false, `Legacy suggestion owner must stay removed: ${legacyOwner}`);
}

assert.equal(
  indexSource.includes('createDiagnosticSuggestionsTransport'),
  false,
  'Webview Bootstrap must not own the Diagnostic Suggestions Transport'
);
assert.equal(
  indexSource.includes('diagnosticSuggestionsTransport'),
  false,
  'Webview Bootstrap must not retain a second request/response owner'
);
assert.equal(
  indexSource.includes('editor?.diagnosticSuggestionPresentationChanged?.()'),
  true,
  'Preview activation must invalidate suggestions through the Editor Runtime input'
);

console.log('Diagnostic suggestion production boundary checks passed');
