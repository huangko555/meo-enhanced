import assert from 'node:assert/strict';
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
let currentTextError: Error | null = null;
let currentAppearance: 'light' | 'dark' = 'light';
let currentEnvironment = { editorBackgroundColor: '#fff' };
let idle = createDeferred();
const adapter = createExportWebviewAdapter({
  postMessage(message) {
    posted.push(message);
  },
  getCurrentText() {
    if (currentTextError) throw currentTextError;
    return currentText;
  },
  whenDocumentIdle: () => idle.promise,
  getPreviewAppearance: () => currentAppearance,
  getStyleEnvironment: () => currentEnvironment
});

adapter.requestExport('html');
assert.deepEqual(posted.shift(), { type: 'exportDocument', format: 'html' });
assert.equal(adapter.accept({ type: 'focusEditor' } as HostToWebviewMessage), false);

assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-1' }), true);
currentText = '# second';
currentAppearance = 'dark';
currentEnvironment = { editorBackgroundColor: '#111' };
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-2' }), true);
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-2' }), true);
assert.equal(posted.length, 0);

idle.resolve();
await Promise.resolve();
await Promise.resolve();
currentText = '# changed after capture';
currentAppearance = 'light';
currentEnvironment.editorBackgroundColor = '#eeeeee';
assert.deepEqual(posted.splice(0), [
  {
    type: 'exportSnapshotResult',
    requestId: 'snapshot-1',
    result: {
      ok: true,
      value: {
        snapshotId: 'snapshot-1',
        text: '# second',
        appearance: 'dark',
        environment: { editorBackgroundColor: '#111' }
      }
    }
  },
  {
    type: 'exportSnapshotResult',
    requestId: 'snapshot-2',
    result: {
      ok: true,
      value: {
        snapshotId: 'snapshot-2',
        text: '# second',
        appearance: 'dark',
        environment: { editorBackgroundColor: '#111' }
      }
    }
  }
]);

idle = createDeferred();
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-capture-failed' }), true);
currentTextError = new Error('Current Revision unavailable');
idle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(posted.shift(), {
  type: 'exportSnapshotResult',
  requestId: 'snapshot-capture-failed',
  result: {
    ok: false,
    error: { code: 'operation-failed', message: 'Current Revision unavailable' }
  }
});
currentTextError = null;

const olderIdle = createDeferred();
idle = olderIdle;
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-before-edit' }), true);
const newerIdle = createDeferred();
idle = newerIdle;
currentText = '# after edit';
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-after-edit' }), true);
olderIdle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(posted.at(0)?.type, 'exportSnapshotResult');
assert.equal((posted.at(0) as { requestId?: string } | undefined)?.requestId, 'snapshot-before-edit');
assert.equal(posted.some((message) => (
  message.type === 'exportSnapshotResult' && message.requestId === 'snapshot-after-edit'
)), false, 'a later snapshot must not reuse a barrier captured before a newer edit');
newerIdle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(posted.map((message) => (
  message.type === 'exportSnapshotResult' ? message.requestId : null
)), ['snapshot-before-edit', 'snapshot-after-edit']);
posted.length = 0;

idle = createDeferred();
currentText = '# next request';
currentAppearance = 'light';
currentEnvironment = { editorBackgroundColor: '#fafafa' };
assert.equal(adapter.accept({ type: 'requestExportSnapshot', requestId: 'snapshot-next-request' }), true);
idle.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(posted.shift(), {
  type: 'exportSnapshotResult',
  requestId: 'snapshot-next-request',
  result: {
    ok: true,
    value: {
      snapshotId: 'snapshot-next-request',
      text: '# next request',
      appearance: 'light',
      environment: { editorBackgroundColor: '#fafafa' }
    }
  }
});

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

console.log('Export Webview Adapter checks passed');
