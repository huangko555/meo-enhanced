import assert from 'node:assert/strict';
import path from 'node:path';
import { mock } from 'bun:test';

type FakeUri = { scheme: string; path: string; fsPath: string; toString(): string };
const uri = (name: string): FakeUri => ({
  scheme: 'file',
  path: '/C:/docs/' + name,
  fsPath: 'C:/docs/' + name,
  toString() { return 'file://' + this.path; }
});
const source = uri('notes.md');
let selected: FakeUri | undefined;
let dialogCount = 0;
let sourceReadCount = 0;
let writeFailure = false;
let readFailure = false;
let corruptRead = false;
const files = new Map<string, Uint8Array>();

mock.module('vscode', () => ({
  Uri: {
    joinPath(_source: FakeUri, _parent: string, name: string) {
      return uri(path.posix.basename(name));
    }
  },
  window: {
    async showSaveDialog() {
      dialogCount += 1;
      return selected;
    }
  },
  workspace: {
    fs: {
      async stat(destination: FakeUri) {
        if (!files.has(destination.fsPath)) throw { code: 'FileNotFound' };
        return { type: 1 };
      },
      async writeFile(destination: FakeUri, bytes: Uint8Array) {
        if (writeFailure) throw new Error('write refused');
        files.set(destination.fsPath, bytes);
      },
      async readFile(destination: FakeUri) {
        if (destination.fsPath === source.fsPath) {
          sourceReadCount += 1;
          throw new Error('source disk is unavailable');
        }
        if (readFailure) throw new Error('copy readback refused');
        const bytes = files.get(destination.fsPath);
        if (!bytes) throw new Error('missing copy');
        return corruptRead ? new Uint8Array([0]) : bytes;
      }
    }
  }
}));

const { createVscodeDocumentCopyAdapter } = await import('../src/host/vscodeDocumentCopyAdapter');
const saved: string[] = [];
const failed: string[] = [];
const adapter = createVscodeDocumentCopyAdapter(source as never, {
  getUiLanguage: () => 'en',
  onSaved: (target) => saved.push(target.fsPath),
  onFailure: (message) => failed.push(message)
});
const request = (requestId: string, text: string) => ({
  type: 'saveDocumentCopy' as const, requestId, text
});

selected = uri('notes-copy.md');
const unicode = '# 草稿\n本地内容';
const success = await adapter.handle(request('copy-1', unicode));
assert.deepEqual(success.result, { ok: true, value: { status: 'saved' } });
assert.equal(new TextDecoder().decode(files.get(selected.fsPath)), unicode);
assert.equal(sourceReadCount, 0, 'saving a copy must never require reading the original disk file');
assert.deepEqual(saved, [selected.fsPath]);
assert.deepEqual(await adapter.handle(request('copy-1', unicode)), success, 'duplicate request must be idempotent');
assert.equal(dialogCount, 1);

selected = uri('empty-copy.md');
assert.deepEqual((await adapter.handle(request('copy-2', ''))).result, {
  ok: true, value: { status: 'saved' }
});
assert.equal(files.get(selected.fsPath)?.length, 0, 'an empty document is still a valid copy');

selected = undefined;
assert.deepEqual((await adapter.handle(request('copy-3', unicode))).result, {
  ok: true, value: { status: 'cancelled' }
});

selected = source;
assert.match(
  String((await adapter.handle(request('copy-4', unicode))).result.ok === false && failed.at(-1)),
  /cannot replace the current document/
);
assert.equal(files.has(source.fsPath), false);

selected = uri('existing.md');
files.set(selected.fsPath, new TextEncoder().encode('keep me'));
assert.equal((await adapter.handle(request('copy-5', unicode))).result.ok, false);
assert.equal(new TextDecoder().decode(files.get(selected.fsPath)), 'keep me');

selected = uri('write-fails.md');
writeFailure = true;
assert.equal((await adapter.handle(request('copy-6', unicode))).result.ok, false);
writeFailure = false;
assert.equal(files.has(selected.fsPath), false);

selected = uri('readback-fails.md');
readFailure = true;
assert.equal((await adapter.handle(request('copy-7', unicode))).result.ok, false);
readFailure = false;
assert.equal(new TextDecoder().decode(files.get(selected.fsPath)), unicode,
  'a readback failure must report uncertainty without touching the current editor');

selected = uri('corrupt-copy.md');
corruptRead = true;
assert.equal((await adapter.handle(request('copy-8', unicode))).result.ok, false);
corruptRead = false;
assert.ok(failed.at(-1)?.includes('did not match'));
adapter.dispose();

console.log('VS Code document copy adapter checks passed');