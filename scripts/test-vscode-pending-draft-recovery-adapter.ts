import assert from 'node:assert/strict';
import { mock } from 'bun:test';

const document = {
  uri: { toString: () => 'file:///recovery.md' },
  version: 1,
  text: 'abc',
  positionAt: (offset: number) => ({ offset }),
  getText: () => document.text
};
class Range {
  constructor(readonly start: { offset: number }, readonly end: { offset: number }) {}
}
class WorkspaceEdit {
  readonly edits: Array<{ range: Range; text: string }> = [];
  replace(_uri: unknown, range: Range, text: string): void { this.edits.push({ range, text }); }
}
let documents: unknown[] = [document];
const copies: string[] = [];
let writes = 0;
mock.module('vscode', () => ({
  Range,
  WorkspaceEdit,
  workspace: {
    get textDocuments() { return documents; },
    applyEdit: async (edit: WorkspaceEdit) => {
      writes += 1;
      const change = edit.edits[0]!;
      document.text = document.text.slice(0, change.range.start.offset)
        + change.text + document.text.slice(change.range.end.offset);
      document.version += 1;
      return true;
    },
    openTextDocument: async ({ content }: { content: string }) => ({ content })
  },
  window: { showTextDocument: async ({ content }: { content: string }) => { copies.push(content); } }
}));

const { createVscodePendingDraftRecoveryAdapter } = await import('../src/host/vscodePendingDraftRecoveryAdapter');
const recovery = createVscodePendingDraftRecoveryAdapter({ document: document as never, noteOwnedFileChange() {} });

recovery.remember({ type: 'draft', baseVersion: 1, text: 'abc!' }, 1);
assert.equal(await recovery.recover(), true);
assert.equal(document.text, 'abc!');
assert.equal(writes, 1);

document.text = 'ayc';
document.version = 3;
recovery.remember({ type: 'conflict', baseVersion: 1, baseText: 'abc', text: 'axc' }, 2);
assert.equal(await recovery.recover(), true);
assert.equal(document.text, 'ayc', 'base conflict must not overwrite the live Host document');
assert.equal(writes, 1, 'base conflict must not call WorkspaceEdit');
assert.match(copies.at(-1) ?? '', /axc/);
assert.match(copies.at(-1) ?? '', /ayc/);

documents = [];
recovery.remember({ type: 'draft', baseVersion: 3, text: 'must not target a reopened URI' }, 3);
assert.equal(await recovery.recover(), true, 'a closed original TextDocument must preserve local recovery without URI reuse');
assert.equal(writes, 1);
assert.match(copies.at(-1) ?? '', /must not target a reopened URI/);
assert.match(copies.at(-1) ?? '', /Host document unavailable/);

console.log('VS Code pending Draft recovery adapter base guard and conflict copy checks passed');
