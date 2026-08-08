import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../src/protocol/messages';
import { createExportWebviewAdapter } from '../webview/src/adapters/exportWebviewAdapter';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const posted: WebviewToHostMessage[] = [];
let currentText = '# first';
let idle = createDeferred();
let idleCalls = 0;
let environmentReads = 0;
const adapter = createExportWebviewAdapter({
  postMessage(message) {
    posted.push(message);
  },
  getCurrentText: () => currentText,
  whenDocumentIdle() {
    idleCalls += 1;
    return idle.promise;
  },
  getPreviewAppearance: () => 'light',
  getStyleEnvironment() {
    environmentReads += 1;
    return { editorBackgroundColor: '#fff' };
  }
});

adapter.requestExport('html');
assert.deepEqual(posted.shift(), { type: 'exportDocument', format: 'html', appearance: 'light' });
assert.equal(adapter.accept({ type: 'focusEditor' } as HostToWebviewMessage), false);

assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-1' }), true);
currentText = '# second';
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-2' }), true);
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-2' }), true);
assert.equal(idleCalls, 1, 'concurrent snapshots should reuse one Document Session idle barrier');
assert.equal(posted.length, 0);

idle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(posted.splice(0), [
  {
    type: 'exportSnapshotResult',
    requestId: 'snapshot-1',
    result: {
      ok: true,
      value: { text: '# first', environment: { editorBackgroundColor: '#fff' } }
    }
  },
  {
    type: 'exportSnapshotResult',
    requestId: 'snapshot-2',
    result: {
      ok: true,
      value: { text: '# second', environment: { editorBackgroundColor: '#fff' } }
    }
  }
]);
assert.equal(environmentReads, 2);

idle = createDeferred();
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-failed' }), true);
idle.reject(new Error('Document Session failed'));
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(posted.shift(), {
  type: 'exportSnapshotResult',
  requestId: 'snapshot-failed',
  result: {
    ok: false,
    error: { code: 'operation-failed', message: 'Document Session failed' }
  }
});

idle = createDeferred();
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-closed' }), true);
adapter.dispose();
adapter.dispose();
assert.deepEqual(posted.shift(), {
  type: 'exportSnapshotResult',
  requestId: 'snapshot-closed',
  result: {
    ok: false,
    error: { code: 'operation-failed', message: 'The editor was closed before export completed.' }
  }
});
idle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(posted.length, 0, 'late idle completion must not emit a second response');
adapter.requestExport('pdf');
assert.equal(posted.length, 0, 'disposed adapter must reject new user actions');

const repoRoot = path.resolve(import.meta.dir, '..');
const bootstrap = fs.readFileSync(path.join(repoRoot, 'webview/src/index.ts'), 'utf8');
assert.equal((bootstrap.match(/createExportWebviewAdapter\s*\(/g) ?? []).length, 1);
for (const forbidden of [
  'createExportHandler',
  'createExportSnapshotResponder',
  "message.type === 'requestExportSnapshot'",
  'handleExportSnapshotRequest'
]) {
  assert.equal(bootstrap.includes(forbidden), false, `Export lifecycle leaked into Bootstrap: ${forbidden}`);
}
assert.match(bootstrap, /exportAdapter\.requestExport\s*\(/);
assert.match(bootstrap, /exportAdapter\.accept\s*\(message\)/);
assert.match(bootstrap, /exportAdapter\.dispose\s*\(\s*\)/);

console.log('Export Webview Adapter checks passed');
