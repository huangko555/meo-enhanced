import assert from 'node:assert/strict';
import {
  decodeHostToWebviewMessage,
  decodeWebviewToHostMessage
} from '../src/protocol/messages';

assert.deepEqual(decodeHostToWebviewMessage({
  type: 'flushDocumentEdits',
  requestId: 'flush-1'
}), {
  type: 'flushDocumentEdits',
  requestId: 'flush-1'
});

assert.deepEqual(decodeWebviewToHostMessage({
  type: 'flushDocumentEditsResult',
  requestId: 'flush-1',
  result: { ok: true, value: { text: 'next' } }
}), {
  type: 'flushDocumentEditsResult',
  requestId: 'flush-1',
  result: { ok: true, value: { text: 'next' } }
});

assert.equal(decodeHostToWebviewMessage({
  type: 'flushDocumentEdits',
  requestId: ''
}), null);
assert.equal(decodeWebviewToHostMessage({
  type: 'flushDocumentEditsResult',
  requestId: 'flush-1',
  result: { ok: true, value: { text: 3 } }
}), null);
assert.equal(decodeWebviewToHostMessage({
  type: 'flushDocumentEditsResult',
  requestId: 'flush-1',
  result: { ok: false, error: { code: 'unknown', message: 'bad' } }
}), null);

console.log('Document save flush Protocol checks passed');
