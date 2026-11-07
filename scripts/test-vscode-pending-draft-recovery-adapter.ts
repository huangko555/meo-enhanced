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
  readonly edits: Array<{ uri: unknown; range: Range; text: string }> = [];
  replace(uri: unknown, range: Range, text: string): void { this.edits.push({ uri, range, text }); }
}
let documents: unknown[] = [document];
const copies: string[] = [];
const copyDocuments: Array<typeof document> = [];
let onShowCopy: (() => Promise<void>) | null = null;
let writes = 0;
let copyUpdateOutcome: 'ok' | 'false' | 'throw' = 'ok';
mock.module('vscode', () => ({
  Range,
  WorkspaceEdit,
  workspace: {
    get textDocuments() { return documents; },
    applyEdit: async (edit: WorkspaceEdit) => {
      const change = edit.edits[0]!;
      const target = [document, ...copyDocuments].find(candidate => candidate.uri === change.uri)!;
      if (target === document) writes += 1;
      const copyIndex = copyDocuments.indexOf(target);
      if (copyIndex >= 0 && copyUpdateOutcome === 'false') return false;
      if (copyIndex >= 0 && copyUpdateOutcome === 'throw') throw new Error('simulated untitled update failure');
      target.text = target.text.slice(0, change.range.start.offset)
        + change.text + target.text.slice(change.range.end.offset);
      target.version += 1;
      if (copyIndex >= 0) copies[copyIndex] = target.text;
      return true;
    },
    openTextDocument: async ({ content }: { content: string }) => {
      const copy = { uri: { toString: () => `untitled:recovery-${copyDocuments.length}` },
        version: 1, text: content, positionAt: (offset: number) => ({ offset }),
        getText: () => copy.text };
      copyDocuments.push(copy); documents.push(copy); copies.push(content);
      return copy;
    }
  },
  window: { showTextDocument: async () => { await onShowCopy?.(); } }
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

for (const outcome of ['owned', 'user-edited', 'closed', 'update-false', 'update-throws'] as const) {
  const adapter = createVscodePendingDraftRecoveryAdapter({ document: document as never, noteOwnedFileChange() {} });
  let started!: () => void, release!: () => void;
  const showing = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  onShowCopy = async () => { started(); await released; };
  const count = copyDocuments.length;
  adapter.remember({ type: 'draft', baseVersion: 1, text: 'older pending local' }, 1);
  const settling = adapter.settleForTermination();
  await showing;
  const copy = copyDocuments.at(-1)!;
  adapter.remember({ type: 'draft', baseVersion: 1, text: 'newest pending local' }, 2);
  if (outcome === 'user-edited') { copy.text = 'user-owned recovery text'; copy.version += 1; }
  if (outcome === 'closed') documents = documents.filter(open => open !== copy);
  if (outcome === 'update-false') copyUpdateOutcome = 'false';
  if (outcome === 'update-throws') copyUpdateOutcome = 'throw';
  release();
  await settling;
  assert.equal(copyDocuments.length, count + (outcome === 'owned' ? 1 : 2),
    'a drain reuses its owned buffer, and preserves separately only after ownership is lost');
  assert.equal(writes, 1, 'recovery artifacts never target the original document');
  if (outcome === 'owned') {
    assert.match(copy.text, /newest pending local/);
    assert.doesNotMatch(copy.text, /older pending local/);
    assert.equal(adapter.hasPending(), false);
  } else {
    assert.equal(adapter.hasPending(), false, 'the latest candidate must survive in a new buffer after ownership is lost');
    if (outcome === 'user-edited') assert.equal(copy.text, 'user-owned recovery text');
    else assert.match(copy.text, /older pending local/);
    assert.match(copyDocuments.at(-1)!.text, /newest pending local/);
  }
  copyUpdateOutcome = 'ok';
  onShowCopy = null;
}

console.log('VS Code pending Draft recovery adapter base guard and conflict copy checks passed');
