import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeWebviewToHostMessage } from '../src/protocol/messages';

const repoRoot = path.resolve(import.meta.dir, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const webviewBootstrap = read('webview/src/index.ts');
const hostSession = read('src/extension/panelSession.ts');
const editorCommands = read('src/protocol/editorCommands.ts');
const gitClient = read('webview/src/helpers/gitClient.ts');
const packageJson = read('package.json');
const documentSessionAdapter = read('webview/src/adapters/documentSessionWebviewAdapter.ts');

assert.equal(fs.existsSync(path.join(repoRoot, 'webview/src/helpers/documentSync.ts')), false);
assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/test-document-sync.ts')), false);
assert.equal(packageJson.includes('scripts/test-document-sync.ts'), false);
assert.equal(gitClient.includes('getSyncedText'), false);

assert.equal(
  (webviewBootstrap.match(/createDocumentSessionWebviewAdapter\s*\(/g) ?? []).length,
  1,
  'production Bootstrap must create exactly one Document Session Webview Adapter'
);
assert.match(webviewBootstrap, /documentSessionAdapter\.start\s*\(message\)/);
assert.match(webviewBootstrap, /documentSessionAdapter\.accept\s*\(message\)/);
assert.match(webviewBootstrap, /documentSessionAdapter\.dispose\s*\(\s*\)/);
assert.equal(webviewBootstrap.includes('createDocumentSessionRuntime'), false);
assert.equal(webviewBootstrap.includes('createDocumentSessionTransport'), false);
assert.equal(webviewBootstrap.includes("type: 'hostRevisionChanged'"), false);
assert.equal(webviewBootstrap.includes("type: 'hostChangeApplied'"), false);
assert.equal(webviewBootstrap.includes("type: 'hostDiscardSucceeded'"), false);
assert.match(documentSessionAdapter, /createDocumentSessionRuntime/);
assert.match(documentSessionAdapter, /createDocumentSessionTransport/);

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
