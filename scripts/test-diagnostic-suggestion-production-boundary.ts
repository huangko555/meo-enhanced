import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const candidateImports = [
  /application\/diagnosticSuggestion/,
  /adapters\/diagnosticSuggestionRuntime/,
  /editor\/diagnosticSuggestionAdapter/
];
for (const file of ['../webview/src/editor.ts', '../webview/src/index.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  for (const candidateImport of candidateImports) {
    assert.equal(
      candidateImport.test(source),
      false,
      `${file} must not import the candidate boundary before the atomic production cutover`
    );
  }
}

console.log('Diagnostic suggestion production boundary checks passed');
