import assert from 'node:assert/strict';
import { createDocumentCopyTransport } from '../webview/src/adapters/documentCopyTransport';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';

assert.deepEqual(decodeWebviewToHostMessage({
  type: 'saveDocumentCopy', requestId: 'copy-1', text: ''
}), { type: 'saveDocumentCopy', requestId: 'copy-1', text: '' });
assert.equal(decodeWebviewToHostMessage({
  type: 'saveDocumentCopy', requestId: 'copy-1'
}), null);
assert.deepEqual(decodeHostToWebviewMessage({
  type: 'documentCopyResult', requestId: 'copy-1',
  result: { ok: true, value: { status: 'cancelled' } }
}), {
  type: 'documentCopyResult', requestId: 'copy-1',
  result: { ok: true, value: { status: 'cancelled' } }
});
const posted: Array<{ type: 'saveDocumentCopy'; requestId: string; text: string }> = [];
const steps: string[] = [];
let currentText: string | null = 'current draft';
const transport = createDocumentCopyTransport({
  getUiLanguage: () => 'en',
  postMessage: (message) => { steps.push('post'); posted.push(message); },
  commitTransientEdits: () => { steps.push('commit'); },
  getCurrentText: () => { steps.push('read'); return currentText; },
  whenDocumentIdle: async () => { steps.push('idle'); }
});
const pending = transport.save();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(steps, ['commit', 'idle', 'read', 'idle', 'post']);
assert.equal(posted[0]?.text, 'current draft');
assert.equal(transport.accept({
  type: 'documentCopyResult',
  requestId: 'wrong-id',
  result: { ok: true, value: { status: 'saved' } }
}), false);
assert.equal(transport.accept({
  type: 'documentCopyResult',
  requestId: posted[0].requestId,
  result: { ok: true, value: { status: 'saved' } }
}), true);
assert.deepEqual(await pending, { ok: true, value: { status: 'saved' } });

currentText = '';
const emptyPending = transport.save();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(posted[1]?.text, '', 'empty documents must be valid snapshots');
transport.accept({
  type: 'documentCopyResult',
  requestId: posted[1].requestId,
  result: { ok: true, value: { status: 'cancelled' } }
});
assert.deepEqual(await emptyPending, { ok: true, value: { status: 'cancelled' } });

currentText = null;
const countBeforeUnavailable = posted.length;
assert.equal((await transport.save()).ok, false);
assert.equal(posted.length, countBeforeUnavailable, 'unavailable content must never produce an empty copy');
transport.dispose();
assert.equal((await transport.save()).ok, false);

console.log('Document copy transport checks passed');