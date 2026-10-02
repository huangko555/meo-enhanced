import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { decodeEditorServiceRequest, decodeEditorServiceResponse } from '../src/protocol/editorServices';
import { createEditorServicesTransport } from '../webview/src/adapters/editorServicesTransport';
let clipboard = '', disposed = 0, include = '', uris: { fsPath: string }[] = [], file = '';
class CancellationTokenSource {
  private cancelled = false;
  get token() { const source = this; return { get isCancellationRequested() { return source.cancelled; } }; }
  cancel() { this.cancelled = true; }
  dispose() { disposed++; }
}
mock.module('vscode', () => ({ CancellationTokenSource, env: { clipboard: { readText: async () => clipboard, writeText: async (text: string) => { clipboard = text; } } }, workspace: { findFiles: async (pattern: string) => { include = pattern; return uris; }, fs: { readFile: async () => new TextEncoder().encode(file) }, asRelativePath: (uri: { fsPath: string }) => uri.fsPath } }));
const { runEditorService } = await import('../src/host/editorServices');
const doc = { fsPath: 'D:/workspace/main.md' } as any;
const request = (change: object) => ({ type: 'editorService', requestId: 'request', ...change } as any);
assert.equal(decodeEditorServiceRequest(request({ action: 'writeClipboard', text: 'x'.repeat(5_000_001) })), null);
assert.equal(decodeEditorServiceRequest(request({ action: 'links', kind: 'bad', query: '', target: '' })), null);
assert.equal(decodeEditorServiceResponse({ type: 'editorServiceResult', requestId: 'x', result: { ok: true, value: { candidates: Array(51).fill({ label: '', insert: '', detail: '' }) } } }), null);
assert.equal((await runEditorService(request({ action: 'writeClipboard', text: 'A\tB' }), doc)).result.ok, true);
const read = await runEditorService(request({ action: 'readClipboard' }), doc); assert.deepEqual(read.result, { ok: true, value: { text: 'A\tB' } });
clipboard = 'x'.repeat(5_000_001); assert.equal((await runEditorService(request({ action: 'readClipboard' }), doc)).result.ok, false);
uris = [{ fsPath: 'D:/workspace/notes/target.md' }];
file = '# Visible\n```\n# Hidden\n```\n## Other ###\n';
const headings = await runEditorService(request({ action: 'links', kind: 'headings', query: '', target: 'notes/target' }), doc);
assert.deepEqual(headings.result.ok && 'candidates' in headings.result.value ? headings.result.value.candidates.map(value => value.label) : null, ['Visible', 'Other']);
assert.ok(include.includes('target'));
file = '# Hello **world**\n\n# Hello **world**\n\nSetext\n======';
const formatted = await runEditorService(request({ action: 'links', kind: 'headings', query: '', target: 'notes/target' }), doc);
assert.deepEqual(formatted.result.ok && 'candidates' in formatted.result.value ? formatted.result.value.candidates.map(value => [value.label, value.anchor]) : null, [['Hello world', 'hello-world'], ['Hello world', 'hello-world-2'], ['Setext', 'setext']]);
assert.equal(decodeEditorServiceResponse({ type: 'editorServiceResult', requestId: 'x', result: { ok: true, value: { candidates: [{ label: 'x', insert: 'x', detail: '', anchor: 42 }] } } }), null);

uris.push({ fsPath: 'D:/workspace/another/target.md' });
const ambiguous = await runEditorService(request({ action: 'links', kind: 'headings', query: '', target: 'target' }), doc);
assert.deepEqual(ambiguous.result, { ok: true, value: { candidates: [] } });
const paths = await runEditorService(request({ action: 'links', kind: 'paths', query: 'notes/', target: '' }), doc);
assert.equal(paths.result.ok && 'candidates' in paths.result.value ? paths.result.value.candidates[0].insert : null, 'notes/target.md');
uris = [{ fsPath: 'D:/workspace/notes/中文 note.md' }];
const encodedTarget = await runEditorService(request({ action: 'links', kind: 'headings', query: 'Setext', target: 'notes/%E4%B8%AD%E6%96%87%20note.md' }), doc);
assert.deepEqual(encodedTarget.result.ok && 'candidates' in encodedTarget.result.value ? encodedTarget.result.value.candidates.map(value => value.anchor) : null, ['setext']);
assert.ok(include.includes('中文 note'), 'encoded Markdown paths resolve to workspace filenames');
const malformedTarget = await runEditorService(request({ action: 'links', kind: 'headings', query: '', target: '%E4' }), doc);
assert.deepEqual(malformedTarget.result, { ok: true, value: { candidates: [] } });
assert.equal(disposed, 6);
const posted: any[] = [];
const transport = createEditorServicesTransport(value => posted.push(value));
const pending = transport.request({ action: 'readClipboard' });
assert.equal(transport.accept({ type: 'editorServiceResult', requestId: 'old', result: { ok: true, value: { text: 'old' } } }), false);
assert.equal(transport.accept({ type: 'editorServiceResult', requestId: posted[0].requestId, result: { ok: true, value: { text: 'fresh' } } }), true);
assert.deepEqual(await pending, { text: 'fresh' });
const cancelled = transport.request({ action: 'links', kind: 'documents', query: '', target: '' }); transport.dispose(); assert.equal(await cancelled, null);
assert.equal(await transport.request({ action: 'readClipboard' }), null);
const failing = createEditorServicesTransport(() => { throw new Error('offline'); }); assert.equal(await failing.request({ action: 'readClipboard' }), null); failing.dispose();
console.log('Editor services: bounded codecs, clipboard failures, targeted file lookup, headings/fences/ambiguity, request correlation and disposal passed');

const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
let expire: (() => void) | undefined;
try {
  globalThis.setTimeout = ((callback: () => void) => { expire = callback; return 1; }) as any;
  globalThis.clearTimeout = (() => {}) as any;
  const timed = createEditorServicesTransport(() => {});
  const expired = timed.request({ action: 'readClipboard' }); expire!(); assert.equal(await expired, null); timed.dispose();
} finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
