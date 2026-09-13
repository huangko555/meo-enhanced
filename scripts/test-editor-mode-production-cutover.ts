import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');
const effectAdapterSource = readFileSync(
  new URL('../webview/src/adapters/editorModeEffectAdapter.ts', import.meta.url),
  'utf8'
);
const previewAdapterSource = readFileSync(
  new URL('../webview/src/adapters/previewWebviewAdapter.ts', import.meta.url),
  'utf8'
);
const hostSessionSource = readFileSync(
  new URL('../src/extension/panelSession.ts', import.meta.url),
  'utf8'
);

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
assert.equal(source.includes('editorModeApplication.dispatch('), false);
assert.equal(source.includes('editorModeEffectAdapter.execute('), false);
assert.equal(
  (source.match(/editor\.setMode\(mode, (?:viewport|editorViewport)\)/g) ?? []).length,
  1,
  'Editor mode application must apply its captured viewport through the injected Effect capability'
);
assert.equal(
  /const editorViewport = [\s\S]*?\? null\s*:\s*viewport;[\s\S]*?editor\.setMode\(mode, editorViewport\)/.test(source),
  true,
  'Deferred editor reveals must derive their final viewport from the captured Effect viewport'
);
assert.equal(
  (source.match(/restoreViewport\(viewport, owner\)\s*\{\s*editor\?\.restoreViewportAnchorToken\?\.\(viewport, owner\);\s*\}/g) ?? []).length,
  1,
  'Viewport restoration must remain a single injected Effect capability'
);
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
assert.equal(
  /\blet\s+(?:currentMode|mode|lastEditableMode|pendingTransition|transitionSequence)\b/.test(effectAdapterSource),
  false,
  'Effect Adapter must not copy Application mode or transition state'
);
assert.equal(previewAdapterSource.includes('restoreActive'), false);
assert.equal(
  /\blet\s+mode:\s*EditorMode\b|\bgetMode:\s*\(\)\s*=>\s*mode\b/.test(hostSessionSource),
  false,
  'Host must persist accepted effects without copying the current Editor Mode owner'
);

console.log('Editor Mode production cutover guards passed');
