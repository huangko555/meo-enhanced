import assert from 'node:assert/strict';
import { mock } from 'bun:test';

const copy = { scheme: 'file', fsPath: 'C:/docs/notes-copy.md', toString: () => 'file:///C:/docs/notes-copy.md' };
const prompts: Array<{ message: string; actions: string[] }> = [];
const commands: Array<{ name: string; args: unknown[] }> = [];
const errors: string[] = [];
let selected: string | undefined;
let commandFailure = false;

mock.module('vscode', () => ({
  window: {
    async showInformationMessage(message: string, ...actions: string[]) {
      prompts.push({ message, actions });
      return selected;
    },
    async showErrorMessage(message: string) { errors.push(message); }
  },
  commands: {
    async executeCommand(name: string, ...args: unknown[]) {
      commands.push({ name, args });
      if (commandFailure) throw new Error('open refused');
    }
  }
}));

const { showSavedDocumentCopyFeedback } = await import('../src/host/vscodeDocumentCopyFeedback');

await showSavedDocumentCopyFeedback(copy as never, 'zh-CN');
assert.deepEqual(prompts.at(-1), {
  message: '副本已保存：C:/docs/notes-copy.md',
  actions: ['打开副本', '打开所在文件夹']
});
assert.equal(commands.length, 0, 'dismissal must leave the current document alone');

selected = '打开副本';
await showSavedDocumentCopyFeedback(copy as never, 'zh-CN');
assert.deepEqual(commands.at(-1), {
  name: 'vscode.open', args: [copy, { preview: false }]
});

selected = '打开所在文件夹';
await showSavedDocumentCopyFeedback(copy as never, 'zh-CN');
assert.deepEqual(commands.at(-1), {
  name: 'revealFileInOS', args: [copy]
});

selected = 'Open Copy';
await showSavedDocumentCopyFeedback(copy as never, 'en');
assert.deepEqual(prompts.at(-1), {
  message: 'Copy saved: C:/docs/notes-copy.md',
  actions: ['Open Copy', 'Open Containing Folder']
});
assert.equal(commands.at(-1)?.name, 'vscode.open');

commandFailure = true;
await showSavedDocumentCopyFeedback(copy as never, 'en');
assert.match(errors.at(-1) ?? '', /Copy saved, but the selected action failed: open refused/);
assert.equal(errors.length, 1, 'an open failure must not be reported as a save failure');

console.log('VS Code document copy feedback checks passed');