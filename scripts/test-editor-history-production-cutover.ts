import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editorSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
const commandsSource = readFileSync(
  new URL('../webview/src/helpers/historyCommands.ts', import.meta.url),
  'utf8'
);
const adapterSource = readFileSync(
  new URL('../webview/src/adapters/editorHistoryEffectAdapter.ts', import.meta.url),
  'utf8'
);
const applicationSource = readFileSync(
  new URL('../webview/src/application/editorHistory.ts', import.meta.url),
  'utf8'
);
const runtimeSource = readFileSync(
  new URL('../webview/src/adapters/editorHistoryRuntime.ts', import.meta.url),
  'utf8'
);

assert.equal(
  (editorSource.match(/createEditorHistoryApplication\(\)/g) ?? []).length,
  1,
  'production Editor must create exactly one Editor History Application'
);
assert.equal(
  (editorSource.match(/createEditorHistoryEffectAdapter\(\{/g) ?? []).length,
  1,
  'production Editor must create exactly one Editor History Effect Adapter'
);
assert.equal(
  (editorSource.match(/createEditorHistoryRuntime\(/g) ?? []).length,
  1,
  'production Editor must create exactly one Editor History Runtime'
);

for (const legacyPattern of [
  /\bHistoryCoordinator\b/,
  /\bhistoryCoordinator\b/,
  /\brecordUserEdit\b/,
  /\bshouldSuppressScroll\b/,
  /\bHistoryFocusIntent\b/,
  /\bHistoryReplayContext\b/,
  /\bHistoryEntry\b/,
  /\bfocusGeneration\b/,
  /\bfocusObserver\b/,
  /\bredoEntries\b/
]) {
  for (const [name, source] of [
    ['Editor', editorSource],
    ['commands helper', commandsSource],
    ['Application', applicationSource],
    ['Effect Adapter', adapterSource],
    ['Runtime', runtimeSource]
  ] as const) {
    assert.equal(legacyPattern.test(source), false, `Legacy Editor History rule returned in ${name}: ${legacyPattern}`);
  }
}

assert.match(commandsSource, /export function runEditorHistoryCommand/);
assert.match(commandsSource, /export function consumeEditorHistoryCommand/);
assert.match(commandsSource, /export function changedDocumentRange/);
assert.match(commandsSource, /runner\(direction\);\s*return true;/s);
assert.match(editorSource, /undo\(\)\s*\{\s*return requestEditorHistoryReplay\('undo'\);/s);
assert.match(editorSource, /redo\(\)\s*\{\s*return requestEditorHistoryReplay\('redo'\);/s);
assert.match(editorSource, /editorHistoryRuntime\?\.dispatch\(\{ type: 'externalDocumentPresented' \}\)/);
assert.match(editorSource, /editorHistoryRuntime\?\.dispatch\(\{ type: 'presentationChanged' \}\)/);
assert.match(editorSource, /editorHistoryRuntime\?\.dispatch\(\{ type: 'localDocumentEdited' \}\)/);
assert.match(editorSource, /editorHistoryRuntime\?\.dispose\(\)/);
const setTextStart = editorSource.search(/\bsetText\s*\(/);
const equalTextReturn = editorSource.indexOf('if (!syncChange)', setTextStart);
const externalHistoryInvalidation = editorSource.indexOf(
  "editorHistoryRuntime?.dispatch({ type: 'externalDocumentPresented' })",
  setTextStart
);
assert.ok(setTextStart >= 0 && equalTextReturn >= 0 && externalHistoryInvalidation >= 0);
assert.ok(
  externalHistoryInvalidation < equalTextReturn,
  'equal-text external presentation must invalidate pending history restore before returning'
);
assert.equal(editorSource.includes('editorHistoryApplication.dispatch('), false);
assert.equal(editorSource.includes('editorHistoryEffectAdapter.execute('), false);
assert.equal(
  /interactionTarget|preferredBlockMode/.test(applicationSource),
  false,
  'Application replay intent must not retain candidate-only presentation details'
);
assert.equal(
  /interactionTarget|preferredBlockMode/.test(adapterSource),
  false,
  'Effect Adapter contract must resolve concrete boundaries after native replay'
);
assert.equal(
  editorSource.includes('recentRenderedReplayPresentation'),
  false,
  'history replay must preserve the user-selected Rendered Block mode without a recent-presentation hint'
);
assert.match(editorSource, /isTableHistoryRange\(view\.state, request\.changedRange\)/);
assert.equal(
  /changedLineIsTable|lineAt\([^\n]+\)\.text\.includes\('\|'\)/.test(editorSource),
  false,
  'plain text containing a pipe must not enter the table focus retry lifecycle'
);
assert.equal(
  runtimeSource.includes("from './editorHistoryEffectAdapter'"),
  false,
  'the Runtime must depend on the Application execution Port, not a sibling concrete Adapter'
);

assert.equal(
  /\blet\s+(?:currentMode|lastEditableMode|historyEntries|redoEntries|historyDepth|pendingReplay|replaySequence)\b/.test(adapterSource),
  false,
  'Effect Adapter must not copy Editor Mode, native history, or Application replay state'
);

console.log('Editor History production cutover guards passed');
