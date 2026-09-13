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
let targetEditorActive = true;
let switchFocusAfterTargetCheck = false;
let skipRevertMutation = false;
let commandFailure: Error | null = null;
const commands: Array<{ command: string; target?: string }> = [];

mock.module('vscode', () => ({
  commands: {
    executeCommand: async (command: string, uri?: FakeDocument['uri']) => {
      commands.push({ command, target: uri?.toString() });
      if (commandFailure) throw commandFailure;
      if (command === 'vscode.open') {
        activeDocument = target;
        return;
      }
      if (command === 'workbench.action.files.revert') {
        if (skipRevertMutation) return;
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
          const checkedDocument = activeDocument;
          if (switchFocusAfterTargetCheck && checkedDocument === target) {
            switchFocusAfterTargetCheck = false;
            activeDocument = other;
          }
          return { input: { uri: checkedDocument.uri } };
        }
      }
    }
  },
  workspace: {
    get textDocuments() {
      return [
        { uri: target.uri, get isDirty() { return target.dirty; } },
        { uri: other.uri, get isDirty() { return other.dirty; } }
      ];
    }
  }
}));

const { createVscodeDocumentReloadAdapter } = await import('../src/host/vscodeDocumentReloadAdapter');

const adapter = createVscodeDocumentReloadAdapter({
  uri: target.uri,
  getText: () => target.text,
  get version() { return target.version; },
  get isDirty() { return target.dirty; }
} as never, {
  isTargetEditorActive: () => targetEditorActive
});

other.dirty = false;
activeDocument = target;
assert.deepEqual(await adapter.reloadFromDisk(), {
  version: 4,
  text: 'disk version from external tool'
});
assert.deepEqual(commands.splice(0), [
  { command: 'workbench.action.files.revert', target: undefined }
]);
assert.equal(other.text, 'other local unsaved', 'binding the target must not touch another tab');

target.text = 'second local draft';
target.dirty = true;
other.text = 'other second local draft';
other.dirty = true;
switchFocusAfterTargetCheck = true;
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /another dirty document makes the active-editor revert unsafe/
);
assert.equal(target.text, 'second local draft');
assert.equal(target.dirty, true, 'a failed target check must preserve the target Draft');
assert.equal(other.text, 'other second local draft');
assert.equal(other.dirty, true, 'a post-check focus race must not revert the newly active dirty tab');
assert.deepEqual(commands.splice(0), []);

activeDocument = other;
other.dirty = false;
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /the target document is no longer active/
);
assert.equal(activeDocument, other, 'Reload must not activate or replace another editor');
assert.deepEqual(commands.splice(0), []);

activeDocument = target;
targetEditorActive = false;
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /the target document is no longer active/
);
assert.equal(activeDocument, target, 'An inactive custom editor must not trigger a global revert');
assert.equal(target.dirty, true);
assert.deepEqual(commands.splice(0), []);
targetEditorActive = true;

activeDocument = target;
skipRevertMutation = true;
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /VS Code did not confirm that the target document was reloaded/
);
assert.equal(activeDocument, target, 'A no-op revert must leave the initiating editor active');
assert.equal(target.dirty, true, 'A no-op revert must not be reported as a successful disk reload');
assert.deepEqual(commands.splice(0), [
  { command: 'workbench.action.files.revert', target: undefined }
]);
skipRevertMutation = false;

activeDocument = target;
other.dirty = false;
commandFailure = new Error('VS Code refused to revert');
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /Could not reload the document from disk: VS Code refused to revert/
);
assert.equal(target.dirty, true);

console.log('VS Code document reload adapter checks passed');
