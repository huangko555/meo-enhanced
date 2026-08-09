import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const candidateImport = /application\/diagnosticSuggestion/;
for (const file of ['../webview/src/editor.ts', '../webview/src/index.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.equal(
    candidateImport.test(source),
    false,
    `${file} must not create or import the candidate before the atomic production cutover`
  );
}

console.log('Diagnostic suggestion production boundary checks passed');
