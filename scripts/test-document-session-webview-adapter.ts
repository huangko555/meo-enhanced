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
const notices: string[] = [];
const unexpected: Array<{ context: string; error: unknown }> = [];

const adapter = createDocumentSessionWebviewAdapter({
  postMessage: (message) => { posted.push(message); },
  presentText: (text, source) => { presented.push({ text, source }); },
  restoreReloadedView: ({ topLine, topLineOffset }) => {
    restored.push({ topLine, topLineOffset });
  },
  showFailureNotice: (message) => { notices.push(message); },
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

adapter.requestReloadFromDisk({ topLine: 7, topLineOffset: 2 });
await adapter.whenIdle();
assert.deepEqual(posted.at(-1), { type: 'reloadDocumentFromDisk', topLine: 7, topLineOffset: 2 });
const postedBeforeCurrentReload = posted.length;
assert.equal(adapter.accept({
  type: 'documentReloadedFromDisk',
  reloadId: 1,
  version: 4,
  text: 'disk version',
  topLine: 7,
  topLineOffset: 2
}), true);
await adapter.whenIdle();
assert.deepEqual(restored, [{ topLine: 7, topLineOffset: 2 }]);
assert.deepEqual(presented.at(-1), { text: 'disk version', source: 'disk-reload' });
assert.deepEqual(posted.at(-1), {
  type: 'documentReloadPresentationCompleted',
  reloadId: 1,
  presented: true
}, 'only a successful final presentation may acknowledge discarding recovery');
assert.equal(
  posted.slice(postedBeforeCurrentReload).some((message) => message.type === 'draftChanged' && message.text === null),
  false,
  'disk reload must not clear Host recovery before its final presentation receipt'
);
const presentedAfterCurrentReload = presented.length;
assert.equal(adapter.accept({
  type: 'documentReloadedFromDisk',
  reloadId: 2,
  version: 3,
  text: 'stale disk version',
  topLine: 2,
  topLineOffset: 9
}), true);
await adapter.whenIdle();
assert.equal(presented.length, presentedAfterCurrentReload, 'a stale reload must not be presented');
assert.deepEqual(
  restored,
  [{ topLine: 7, topLineOffset: 2 }],
  'a stale reload must not restore an obsolete viewport'
);
assert.equal(adapter.accept({
  type: 'documentReloadFromDiskFailed',
  message: 'Could not reload the document from disk: VS Code refused to revert'
}), true);
await adapter.whenIdle();
assert.deepEqual(notices, ['Could not reload the document from disk: VS Code refused to revert']);

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
  restoreReloadedView: () => undefined,
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

const testAsyncReloadPresentation = async (
  succeeded: boolean,
  topLine: number,
  expectedRestores: readonly number[],
  reloadId: number
): Promise<void> => {
  let finishPresentation!: (succeeded: boolean) => void;
  const presentation = new Promise<boolean>((resolve) => {
    finishPresentation = resolve;
  });
  const asyncRestores: number[] = [];
  const asyncAdapter = createDocumentSessionWebviewAdapter({
    postMessage: (message) => { asyncMessages.push(message); },
    presentText: () => presentation,
    restoreReloadedView: ({ topLine }) => { asyncRestores.push(topLine); },
    showFailureNotice: () => undefined,
    reportUnexpectedError: (context, error) => {
      throw new Error(`${context}: ${String(error)}`);
    }
  });
  const asyncMessages: WebviewToHostMessage[] = [];
  asyncAdapter.start(init);
  await asyncAdapter.whenIdle();
  assert.equal(asyncAdapter.accept({
    type: 'documentReloadedFromDisk',
    reloadId,
    version: 2,
    text: 'async disk version',
    topLine,
    topLineOffset: 4
  }), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(asyncRestores, [], 'reload must wait for the final presentation result');
  finishPresentation(succeeded);
  await asyncAdapter.whenIdle();
  assert.deepEqual(asyncRestores, expectedRestores);
  assert.deepEqual(asyncMessages, [{
    type: 'documentReloadPresentationCompleted',
    reloadId,
    presented: succeeded
  }]);
  asyncAdapter.dispose();
};

await testAsyncReloadPresentation(false, 11, [], 3);
await testAsyncReloadPresentation(true, 13, [13], 4);

console.log('Document Session Webview Adapter checks passed');
