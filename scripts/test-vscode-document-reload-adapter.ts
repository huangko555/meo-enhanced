import assert from 'node:assert/strict';
import { mock } from 'bun:test';

type FakeDocument = {
  readonly uri: { toString(): string };
  text: string;
  version: number;
  dirty: boolean;
};

const createDocument = (uri: string, text: string, version: number): FakeDocument => ({
  uri: { toString: () => uri },
  text,
  version,
  dirty: true
});

const target = createDocument('file:///target.md', 'local unsaved', 3);
const other = createDocument('file:///other.md', 'other local unsaved', 8);
let activeDocument = other;
let switchFocusAfterOpen = false;
let commandFailure: Error | null = null;
const commands: Array<{ command: string; target?: string }> = [];

mock.module('vscode', () => ({
  commands: {
    executeCommand: async (command: string, uri?: FakeDocument['uri']) => {
      commands.push({ command, target: uri?.toString() });
      if (commandFailure) throw commandFailure;
      if (command === 'vscode.open') {
        activeDocument = target;
        if (switchFocusAfterOpen) activeDocument = other;
        return;
      }
      if (command === 'workbench.action.files.revert') {
        activeDocument.text = activeDocument === target
          ? 'disk version from external tool'
          : 'other disk version';
        activeDocument.version += 1;
        activeDocument.dirty = false;
      }
    }
  },
  window: {
    tabGroups: {
      activeTabGroup: {
        get activeTab() {
          return { input: { uri: activeDocument.uri } };
        }
      }
    }
  }
}));

const { createVscodeDocumentReloadAdapter } = await import('../src/host/vscodeDocumentReloadAdapter');

const adapter = createVscodeDocumentReloadAdapter({
  uri: target.uri,
  getText: () => target.text,
  get version() { return target.version; },
  get isDirty() { return target.dirty; }
} as never);

assert.deepEqual(await adapter.reloadFromDisk(), {
  version: 4,
  text: 'disk version from external tool'
});
assert.deepEqual(commands.splice(0), [
  { command: 'vscode.open', target: 'file:///target.md' },
  { command: 'workbench.action.files.revert', target: undefined }
]);
assert.equal(other.dirty, true, 'binding the target must not revert another dirty tab');

target.text = 'second local draft';
target.dirty = true;
other.text = 'other second local draft';
other.dirty = true;
switchFocusAfterOpen = true;
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /target document is no longer active/
);
assert.equal(target.text, 'second local draft');
assert.equal(target.dirty, true, 'a failed target check must preserve the target Draft');
assert.equal(other.text, 'other second local draft');
assert.equal(other.dirty, true, 'a focus race must not revert the newly active dirty tab');
assert.deepEqual(commands.splice(0), [
  { command: 'vscode.open', target: 'file:///target.md' }
]);

switchFocusAfterOpen = false;
commandFailure = new Error('VS Code refused to revert');
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /Could not reload the document from disk: VS Code refused to revert/
);
assert.equal(target.dirty, true);

console.log('VS Code document reload adapter checks passed');
