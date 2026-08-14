import assert from 'node:assert/strict';
import { mock } from 'bun:test';

let documentText = 'local unsaved';
let documentVersion = 3;
let commandFailure: Error | null = null;
const commands: string[] = [];

mock.module('vscode', () => ({
  commands: {
    executeCommand: async (command: string) => {
      commands.push(command);
      if (commandFailure) throw commandFailure;
      documentText = 'disk version from external tool';
      documentVersion = 4;
    }
  }
}));

const { createVscodeDocumentReloadAdapter } = await import('../src/host/vscodeDocumentReloadAdapter');

const adapter = createVscodeDocumentReloadAdapter({
  getText: () => documentText,
  get version() { return documentVersion; }
} as never);

assert.deepEqual(await adapter.reloadFromDisk(), {
  version: 4,
  text: 'disk version from external tool'
});
assert.deepEqual(commands, ['workbench.action.files.revert']);

commandFailure = new Error('VS Code refused to revert');
await assert.rejects(
  () => adapter.reloadFromDisk(),
  /Could not reload the document from disk: VS Code refused to revert/
);

console.log('VS Code document reload adapter checks passed');
