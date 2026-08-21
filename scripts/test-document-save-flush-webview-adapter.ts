import assert from 'node:assert/strict';
import type { WebviewToHostMessage } from '../src/protocol/messages';
import { createDocumentSaveFlushWebviewAdapter } from '../webview/src/adapters/documentSaveFlushWebviewAdapter';

type Deferred = {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const posted: WebviewToHostMessage[] = [];
let text = 'outer Draft';
let pendingCellText = 'outer Draft with pending cell';
let commitCount = 0;
let idle = deferred();
const adapter = createDocumentSaveFlushWebviewAdapter({
  postMessage: (message) => { posted.push(message); },
  commitTransientEdits: () => {
    commitCount += 1;
    if (pendingCellText) {
      text = pendingCellText;
      pendingCellText = '';
    }
  },
  getCurrentText: () => text,
  whenDocumentIdle: () => idle.promise
});

assert.equal(adapter.accept({ type: 'focusEditor' }), false);
assert.equal(adapter.accept({ type: 'flushDocumentEdits', requestId: 'flush-1' }), true);
assert.equal(adapter.accept({ type: 'flushDocumentEdits', requestId: 'flush-1' }), true);
assert.equal(commitCount, 1, 'duplicate pending request must not commit twice');
assert.equal(posted.length, 0, 'response must wait for the Document Session barrier');
idle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(posted, [{
  type: 'flushDocumentEditsResult',
  requestId: 'flush-1',
  result: { ok: true, value: { text: 'outer Draft with pending cell' } }
}]);

posted.length = 0;
assert.equal(adapter.accept({ type: 'flushDocumentEdits', requestId: 'flush-1' }), true);
assert.equal(commitCount, 1);
assert.equal(posted.length, 1, 'completed duplicate request must replay only its cached response');

posted.length = 0;
idle = deferred();
assert.equal(adapter.accept({ type: 'flushDocumentEdits', requestId: 'flush-no-pending' }), true);
idle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(posted, [{
  type: 'flushDocumentEditsResult',
  requestId: 'flush-no-pending',
  result: { ok: true, value: { text: 'outer Draft with pending cell' } }
}]);

posted.length = 0;
idle = deferred();
assert.equal(adapter.accept({ type: 'flushDocumentEdits', requestId: 'flush-disposed' }), true);
adapter.dispose();
assert.deepEqual(posted, [{
  type: 'flushDocumentEditsResult',
  requestId: 'flush-disposed',
  result: {
    ok: false,
    error: {
      code: 'operation-failed',
      message: 'The editor closed before pending changes could be prepared for save.'
    }
  }
}]);
idle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(posted.length, 1, 'late idle completion after dispose must not emit a second response');

{
  const failures: WebviewToHostMessage[] = [];
  const failed = createDocumentSaveFlushWebviewAdapter({
    postMessage: (message) => { failures.push(message); },
    commitTransientEdits: () => { throw new Error('commit failed'); },
    getCurrentText: () => 'unreachable',
    whenDocumentIdle: async () => undefined
  });
  failed.accept({ type: 'flushDocumentEdits', requestId: 'flush-failed' });
  assert.deepEqual(failures, [{
    type: 'flushDocumentEditsResult',
    requestId: 'flush-failed',
    result: { ok: false, error: { code: 'operation-failed', message: 'commit failed' } }
  }]);
  failed.dispose();
}

console.log('Document save flush Webview Adapter checks passed');
