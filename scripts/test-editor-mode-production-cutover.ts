import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');

for (const legacyPattern of [
  /\blet currentMode\b/,
  /\blet lastEditableMode\b/,
  /\blet hasLocalModePreference\b/,
  /\bconst applyMode\b/,
  /\bmountInitialEditor\b/,
  /\bscheduleInitialEditorMount\b/,
  /\binitialMountRecoveryAttempted\b/,
  /\bmodeToggleShouldRestoreEditorFocus\b/
]) {
  assert.equal(legacyPattern.test(source), false, `Legacy Editor Mode rule returned: ${legacyPattern}`);
}

assert.equal(
  (source.match(/const editorModeApplication = createEditorModeApplication\(\)/g) ?? []).length,
  1
);
assert.equal(
  (source.match(/const editorModeEffectAdapter = createEditorModeEffectAdapter\(\{/g) ?? []).length,
  1
);
assert.equal((source.match(/editorModeRuntime = createEditorModeRuntime\(/g) ?? []).length, 1);
assert.equal(
  (source.match(/type: 'setMode'/g) ?? []).length,
  1,
  'setMode Command may only be emitted by the injected postMode capability'
);
assert.equal(
  source.includes("type: 'toggleMode', source: 'host-command'"),
  true,
  'Host toggleMode must enter the Runtime as an Application input'
);
assert.equal(source.includes('editorModeRuntime.dispose()'), true);

console.log('Editor Mode production cutover guards passed');
