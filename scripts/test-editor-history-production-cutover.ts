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
  assert.equal(legacyPattern.test(editorSource), false, `Legacy Editor History rule returned: ${legacyPattern}`);
  assert.equal(legacyPattern.test(commandsSource), false, `Legacy Editor History helper returned: ${legacyPattern}`);
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
assert.equal(editorSource.includes('editorHistoryApplication.dispatch('), false);
assert.equal(editorSource.includes('editorHistoryEffectAdapter.execute('), false);

assert.equal(
  /\blet\s+(?:currentMode|lastEditableMode|historyEntries|redoEntries|historyDepth|pendingReplay|replaySequence)\b/.test(adapterSource),
  false,
  'Effect Adapter must not copy Editor Mode, native history, or Application replay state'
);

console.log('Editor History production cutover guards passed');
