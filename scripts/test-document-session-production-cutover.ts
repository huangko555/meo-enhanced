import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeWebviewToHostMessage } from '../src/protocol/messages';

const repoRoot = path.resolve(import.meta.dir, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const webviewBootstrap = read('webview/src/index.ts');
const hostSession = read('src/extension/panelSession.ts');
const editorCommands = read('src/protocol/editorCommands.ts');

assert.equal(
  (webviewBootstrap.match(/createDocumentSessionRuntime\s*\(/g) ?? []).length,
  1,
  'production Bootstrap must create exactly one Document Session runtime'
);
assert.match(webviewBootstrap, /documentSessionRuntime\.initialize\s*\(message\)/);

for (const legacyIdentifier of [
  'pendingText',
  'syncedText',
  'inFlightText',
  'inFlightBaseVersion',
  'saveAfterSync',
  'flushChanges',
  'flushPendingChangesNow',
  'maybeSaveAfterSync',
  'reconcileExternalDocument'
]) {
  assert.equal(
    new RegExp(`\\b${legacyIdentifier}\\b`).test(webviewBootstrap),
    false,
    `Legacy Webview synchronization identifier returned: ${legacyIdentifier}`
  );
}

assert.equal(decodeWebviewToHostMessage({ type: 'saveDocument' }), null);
assert.equal(editorCommands.includes("type: 'saveDocument'"), false);
assert.equal(hostSession.includes("case 'saveDocument':"), false);
assert.match(hostSession, /case 'draftChanged':/);
assert.match(hostSession, /pendingDraftText/);
assert.match(hostSession, /applyPendingDraftIfNeeded/);

console.log('Document Session production cutover guards passed');
