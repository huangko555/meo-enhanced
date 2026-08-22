import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const read = (file: string): string => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const trackedProductSources = [
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'src/shared/extensionConfig.ts',
  'src/protocol/readyInit.ts',
  'src/protocol/editorCommands.ts',
  'src/protocol/hostEditorEvents.ts',
  'src/extension/panelSession.ts',
  'webview/src/index.ts',
  'webview/src/editor.ts'
] as const;

for (const forbidden of [
  'collapseLongBlocks',
  'LONG_CODE_BLOCKS_COLLAPSE_SETTING_KEY',
  'longCodeBlockFoldingEnabled',
  'setLongCodeBlockFolding',
  'longCodeBlockFoldingChanged',
  'setLongCodeBlockFoldingEnabled',
  'longCodeBlockFoldingBtn'
]) {
  const owners = trackedProductSources.filter((file) => read(file).includes(forbidden));
  assert.deepEqual(owners, [], `${forbidden} must not escape the Editor-session UI owner: ${owners.join(', ')}`);
}

const longCodeModule = read('webview/src/helpers/longCodeBlocks.ts');
assert.doesNotMatch(longCodeModule, /\benabled\s*:/, 'session folding must always be active in Live mode');
assert.doesNotMatch(longCodeModule, /setLongCodeBlockFoldingEnabledEffect/);
assert.deepEqual(
  Array.from(longCodeModule.matchAll(/export\s+(?:const|function|class|type)\s+(\w+)/g), (match) => match[1]),
  ['longCodeBlockSessionUiExtension'],
  'CodeMirror effects, fields, records and DOM widgets must stay behind the session UI Interface'
);
const directConsumers = [
  'webview/src/editor.ts',
  'webview/src/index.ts',
  'webview/src/sourceMode.ts',
  'webview/src/preview.ts'
].filter((file) => fs.existsSync(path.join(repoRoot, file)))
  .filter((file) => read(file).includes("helpers/longCodeBlocks"));
assert.deepEqual(directConsumers, [], 'only the Live seam may install the Long Code Block Session UI');

const publicBehaviorContract = read('scripts/test-long-code-blocks.ts');
for (const internalName of ['manualCollapsed', 'temporaryTarget', 'longCodeBlockStateField']) {
  assert.doesNotMatch(
    publicBehaviorContract,
    new RegExp(internalName),
    `production behavior contract must not inspect ${internalName}`
  );
}

console.log('Long code block session UI cutover checks passed');
