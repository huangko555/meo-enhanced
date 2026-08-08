import assert from 'node:assert/strict';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../src/protocol/messages';
import type { InitMessage } from '../src/protocol/readyInit';
import { createDocumentSessionWebviewAdapter } from '../webview/src/adapters/documentSessionWebviewAdapter';

const init = {
  type: 'init',
  documentId: 'file:///adapter.md',
  text: 'one',
  version: 1,
  savedRevision: { version: 1, text: 'one' }
} as InitMessage;

const posted: WebviewToHostMessage[] = [];
const presented: Array<{ text: string; source: string }> = [];
const restored: Array<{ topLine: number; topLineOffset: number }> = [];
const unexpected: Array<{ context: string; error: unknown }> = [];

const adapter = createDocumentSessionWebviewAdapter({
  postMessage: (message) => { posted.push(message); },
  presentText: (text, source) => { presented.push({ text, source }); },
  restoreDiscardedView: ({ topLine, topLineOffset }) => {
    restored.push({ topLine, topLineOffset });
  },
  showFailureNotice: () => undefined,
  reportUnexpectedError: (context, error) => { unexpected.push({ context, error }); }
});

adapter.start(init);
adapter.start({ ...init, version: 9, text: 'must-not-restart' });
adapter.localDraftChanged('one local');
await adapter.whenIdle();
assert.deepEqual(posted.slice(0, 2), [
  { type: 'draftChanged', text: 'one local' },
  {
    type: 'applyChanges',
    baseVersion: 1,
    changes: [{ from: 0, to: 3, insert: 'one local' }]
  }
]);

assert.equal(adapter.accept({ type: 'applied', version: 2 }), true);
assert.equal(adapter.accept({ type: 'docChanged', version: 3, text: 'remote' }), true);
assert.equal(adapter.accept({ type: 'themeChanged' } as HostToWebviewMessage), false);
await adapter.whenIdle();
assert.deepEqual(presented.at(-1), { text: 'remote', source: 'revision' });

adapter.requestDiscard({ topLine: 7, topLineOffset: 2 });
await adapter.whenIdle();
assert.deepEqual(posted.at(-1), { type: 'discardChanges', topLine: 7, topLineOffset: 2 });
assert.equal(adapter.accept({
  type: 'discardedChanges',
  version: 4,
  text: 'one',
  topLine: 7,
  topLineOffset: 2
}), true);
await adapter.whenIdle();
assert.deepEqual(restored, [{ topLine: 7, topLineOffset: 2 }]);

adapter.requestSave();
for (let attempt = 0; attempt < 10 && posted.at(-1)?.type !== 'saveDocumentRevision'; attempt += 1) {
  await Promise.resolve();
}
const saveRequest = posted.at(-1);
assert.equal(saveRequest?.type, 'saveDocumentRevision');
adapter.dispose();
await adapter.whenIdle();
if (saveRequest?.type === 'saveDocumentRevision') {
  assert.equal(adapter.accept({
    type: 'saveDocumentRevisionResult',
    requestId: saveRequest.requestId,
    result: { ok: true, value: { revision: saveRequest.revision } }
  }), true);
}
adapter.localDraftChanged('ignored after dispose');
await adapter.whenIdle();
assert.equal(posted.some(message => message.type === 'draftChanged' && message.text === 'ignored after dispose'), false);
assert.deepEqual(unexpected, []);

const earlyErrors: string[] = [];
const earlyAdapter = createDocumentSessionWebviewAdapter({
  postMessage: () => undefined,
  presentText: () => undefined,
  restoreDiscardedView: () => undefined,
  showFailureNotice: () => undefined,
  reportUnexpectedError: (context) => { earlyErrors.push(context); }
});
earlyAdapter.localDraftChanged('too early');
await earlyAdapter.whenIdle();
assert.deepEqual(earlyErrors, ['local draft']);
earlyAdapter.start(init);
earlyAdapter.localDraftChanged('recovered');
await earlyAdapter.whenIdle();
earlyAdapter.dispose();

console.log('Document Session Webview Adapter checks passed');
