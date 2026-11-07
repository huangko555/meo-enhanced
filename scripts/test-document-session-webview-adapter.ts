import assert from 'node:assert/strict';
import { ChangeSet, Text } from '@codemirror/state';
import { createPendingDraftRecovery } from '../src/application/pendingDraftRecovery';
import { createDraftRecoveryReceiver } from '../src/host/draftRecoveryReceiver';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../src/protocol/messages';
import type { InitMessage } from '../src/protocol/readyInit';
import { createDocumentSessionWebviewAdapter } from '../webview/src/adapters/documentSessionWebviewAdapter';
import { documentEdit, documentSnapshotFromString } from '../webview/src/adapters/documentSnapshot';

const pageId = 'page_webview_adapter';
const init = {
  type: 'init',
  pageId,
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
  pageId,
  postMessage: (message) => { posted.push(message); },
  presentText: (text, source) => { presented.push({ text, source }); },
  restoreReloadedView: ({ topLine, topLineOffset }) => {
    restored.push({ topLine, topLineOffset });
  },
  showNotice: (notice) => { notices.push(notice); },
  reportUnexpectedError: (context, error) => { unexpected.push({ context, error }); }
});

adapter.start(init);
adapter.start({ ...init, version: 9, text: 'must-not-restart' });
adapter.localDraftChanged('one local');
await adapter.whenIdle();
assert.equal(adapter.readCurrentText()?.toString(), 'one local', 'the immutable read surface follows the latest draft');
assert.deepEqual(posted.slice(0, 2), [
  { type: 'draftChanged', pageId, text: 'one local', baseVersion: 1, receiptVersion: 1 },
  {
    type: 'applyChanges',
    baseVersion: 1,
    changes: [{ from: 3, to: 3, insert: ' local' }]
  }
]);

assert.equal(adapter.accept({ type: 'applied', version: 2 }), true);
assert.equal(adapter.accept({ type: 'docChanged', version: 3, text: 'remote' }), true);
assert.equal(adapter.accept({ type: 'themeChanged' } as HostToWebviewMessage), false);
await adapter.whenIdle();
assert.deepEqual(presented.at(-1), { text: 'remote', source: 'revision' });
assert.equal(adapter.readCurrentText()?.toString(), 'remote', 'accepted Host revisions replace the shared read surface');

// A delayed Init or recovery snapshot request from another iframe generation
// must be inert; only the bootstrap page identity owns this adapter.
{
  const identityMessages: WebviewToHostMessage[] = [];
  const identityAdapter = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { identityMessages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice() {}, reportUnexpectedError: (_context, error) => { throw error; }
  });
  identityAdapter.start({ ...init, pageId: 'page_other_generation' });
  assert.equal(identityAdapter.readCurrentText(), null, 'an Init targeted to another page must not initialize this page');
  identityAdapter.start(init);
  identityAdapter.localDraftChanged('page-owned draft');
  await identityAdapter.whenIdle();
  const beforeWrongRequest = identityMessages.length;
  assert.equal(identityAdapter.accept({ type: 'requestDraftRecoverySnapshot', pageId: 'page_other_generation' }), true);
  await identityAdapter.whenIdle();
  assert.equal(identityMessages.length, beforeWrongRequest, 'wrong-page snapshot requests are ignored');
  assert.equal(identityAdapter.accept({ type: 'requestDraftRecoverySnapshot', pageId }), true);
  await identityAdapter.whenIdle();
  assert.equal(identityMessages.at(-1)?.type, 'draftChanged', 'the active page may request its own full recovery snapshot');
}

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
  presented: true,
  receiptVersion: 2
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
assert.deepEqual(notices, ['reload-from-disk-failed']);
assert.equal(unexpected.at(-1)?.context, 'document reload failure');
assert.match(String(unexpected.at(-1)?.error), /VS Code refused to revert/);

adapter.requestSave();
for (let attempt = 0; attempt < 10 && posted.at(-1)?.type !== 'saveDocumentRevision'; attempt += 1) {
  await Promise.resolve();
}
const saveRequest = posted.at(-1);
assert.equal(saveRequest?.type, 'saveDocumentRevision');
adapter.dispose();
assert.equal(adapter.readCurrentText(), null, 'disposed sessions expose no mountable text');
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
assert.equal(unexpected.length, 1, 'the raw reload failure should only be logged once');

const earlyErrors: string[] = [];
const earlyAdapter = createDocumentSessionWebviewAdapter({
  pageId,
  postMessage: () => undefined,
  presentText: () => undefined,
  restoreReloadedView: () => undefined,
  showNotice: () => undefined,
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
    pageId,
    postMessage: (message) => { asyncMessages.push(message); },
    presentText: () => presentation,
    restoreReloadedView: ({ topLine }) => { asyncRestores.push(topLine); },
    showNotice: () => undefined,
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
    presented: succeeded,
    receiptVersion: 0
  }]);
  asyncAdapter.dispose();
};

await testAsyncReloadPresentation(false, 11, [], 3);
await testAsyncReloadPresentation(true, 13, [13], 4);

const retryPresentations: string[] = [];
let failPresentation = true;
const retryAdapter = createDocumentSessionWebviewAdapter({
  pageId,
  postMessage: () => undefined,
  presentText: (text) => {
    retryPresentations.push(text);
    return !failPresentation;
  },
  restoreReloadedView: () => undefined,
  showNotice: () => undefined,
  reportUnexpectedError: (context, error) => { throw new Error(`${context}: ${String(error)}`); }
});
retryAdapter.start(init);
await retryAdapter.whenIdle();
retryAdapter.accept({ type: 'docChanged', version: 2, text: 'new revision' });
await retryAdapter.whenIdle();
assert.deepEqual(retryPresentations, ['new revision']);
failPresentation = false;
assert.equal(await retryAdapter.retryPresentation(), true);
assert.deepEqual(retryPresentations, ['new revision', 'new revision'],
  'manual retry must present the failed Revision through the ordered session');
assert.equal(await retryAdapter.retryPresentation(), false,
  'successful presentation must clear the retry candidate');
failPresentation = true;
retryAdapter.accept({ type: 'docChanged', version: 3, text: 'newer revision' });
await retryAdapter.whenIdle();
retryAdapter.localDraftChanged('user typed after the failure');
await retryAdapter.whenIdle();
failPresentation = false;
assert.equal(await retryAdapter.retryPresentation(), false,
  'a later local edit must invalidate the stale failed presentation');
retryAdapter.dispose();

for (const input of ['init', 'docChanged', 'reload', 'revision-response'] as const) {
  const logicalText = 'first\nsecond';
  const messages: WebviewToHostMessage[] = [];
  const failures: unknown[] = [];
  const presentations: string[] = [];
  const session = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage(message) {
      messages.push(message);
      if (message.type === 'requestDocumentRevision') {
        session.accept({ type: 'documentRevisionResult', requestId: message.requestId,
          result: { ok: true, value: { revision: { version: 2, text: logicalText.replace(/\n/g, '\r\n') } } } });
      }
      if (message.type === 'saveDocumentRevision') {
        session.accept({ type: 'saveDocumentRevisionResult', requestId: message.requestId,
          result: { ok: true, value: { revision: { ...message.revision, text: message.revision.text.replace(/\n/g, '\r\n') } } } });
      }
    },
    presentText: text => { presentations.push(text); },
    restoreReloadedView() {},
    showNotice: notice => { failures.push(notice); },
    reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  const initialText = input === 'init' ? logicalText.replace(/\n/g, '\r\n') : logicalText;
  session.start({ ...init, text: initialText, savedRevision: { version: 1, text: initialText } });
  await session.whenIdle();
  if (input === 'docChanged') session.accept({ type: 'docChanged', version: 2, text: 'first\r\nsecond' });
  if (input === 'reload') session.accept({ type: 'documentReloadedFromDisk', reloadId: 1, version: 2,
    text: 'first\r\nsecond', topLine: 1, topLineOffset: 0 });
  if (input === 'revision-response') session.accept({ type: 'docChanged', version: 1, text: 'conflicting revision' });
  await session.whenIdle();
  const beforeEquivalentDraft = messages.length;
  session.localDraftChanged(logicalText);
  await session.whenIdle();
  assert.equal(messages.length, beforeEquivalentDraft, `${input}: EOL-only differences must not create a Draft or Change`);
  assert.ok(presentations.every(text => !text.includes('\r')), `${input}: presentation must be canonical`);
  session.localDraftChanged(logicalText + '!');
  await session.whenIdle();
  const baseVersion = input === 'init' ? 1 : 2;
  assert.deepEqual(messages.filter(message => message.type === 'applyChanges'), [{
    type: 'applyChanges', baseVersion, changes: [{ from: logicalText.length, to: logicalText.length, insert: '!' }]
  }], `${input}: a local edit must remain a local Change`);
  session.accept({ type: 'applied', version: baseVersion + 1 });
  await session.whenIdle();
  session.requestSave();
  await session.whenIdle();
  const save = messages.find(message => message.type === 'saveDocumentRevision');
  assert.ok(save?.type === 'saveDocumentRevision');
  assert.deepEqual(save.revision, { version: baseVersion + 1, text: logicalText + '!' });
  const beforeSavedEcho = messages.length;
  session.localDraftChanged(logicalText + '!');
  await session.whenIdle();
  assert.equal(messages.length, beforeSavedEcho, `${input}: the saved Revision must remain clean`);
  assert.deepEqual(failures, [], `${input}: CRLF save confirmation must succeed`);
  session.dispose();
}

// Teardown cannot wait for the session's microtask/remote-operation queue.
// Preserve the newest queued local input synchronously, without inventing a
// draft for a clean editor or allowing older work to clear that final receipt.
for (const pending of [false, true]) {
  const messages: WebviewToHostMessage[] = [], failures: unknown[] = [];
  const closing = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice: notice => { failures.push(notice); }, reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  closing.start(init); await closing.whenIdle();
  if (pending) { closing.localDraftChanged('one intermediate'); closing.localDraftChanged('one final input'); }
  closing.dispose();
  const recovery = messages.filter(message => message.type === 'draftChanged');
  assert.deepEqual(recovery.map(message => message.text), pending ? ['one final input'] : [], 'Close must preserve only the newest queued local input before returning');
  const count = messages.length;
  await closing.whenIdle();
  assert.equal(messages.length, count, 'Older queued work must not publish after close');
  assert.deepEqual(failures, []);
}

// Starting the adapter task only schedules runtime.handle. Close at every
// small microtask boundary must retain each input until coordinator.handle has
// accepted it. If ordinary recovery already posted, teardown sends one
// full terminal retry with the same receipt rather than inventing a new edit.
for (const microtasksBeforeClose of [0, 1, 2, 3, 4, 5, 6]) {
  const messages: WebviewToHostMessage[] = [], failures: unknown[] = [];
  const closing = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice: notice => { failures.push(notice); }, reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  closing.start(init); await closing.whenIdle();
  closing.localDraftChanged('one final at a microtask boundary');
  for (let index = 0; index < microtasksBeforeClose; index += 1) await Promise.resolve();
  closing.dispose();
  const recovery = messages.filter(message => message.type === 'draftChanged');
  assert.ok(recovery.every(message => message.text === 'one final at a microtask boundary'),
    `close after ${microtasksBeforeClose} microtasks must preserve only the latest local recovery text`);
  assert.equal(recovery.filter(message => message.terminal === true).length, 1,
    `close after ${microtasksBeforeClose} microtasks must emit exactly one terminal recovery snapshot`);
  await closing.whenIdle();
  assert.equal(messages.filter(message => message.type === 'draftChanged').length, recovery.length,
    `close after ${microtasksBeforeClose} microtasks must not publish after terminal handoff`);
  assert.deepEqual(failures, []);
}

// Init establishes the coordinator synchronously, so the documented
// start -> local -> close order is recoverable even without a microtask turn.
for (const closeImmediately of [false, true]) {
  const messages: WebviewToHostMessage[] = [];
  const sameStack = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {}, showNotice() {},
    reportUnexpectedError: (context, error) => { throw new Error(`${context}: ${String(error)}`); }
  });
  sameStack.start(init);
  sameStack.localDraftChanged('same stack final input');
  sameStack.dispose();
  assert.deepEqual(messages.filter(message => message.type === 'draftChanged'), [{
    type: 'draftChanged', pageId, text: 'same stack final input', baseVersion: 1, terminal: true, receiptVersion: 1
  }]);
}

{
  const messages: WebviewToHostMessage[] = [], failures: unknown[] = [];
  const closing = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice: notice => { failures.push(notice); }, reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  closing.start(init); await closing.whenIdle();
  closing.localDraftChanged('one earlier'); await closing.whenIdle();
  closing.accept({ type: 'applied', version: 2 }); await closing.whenIdle();
  closing.requestSave();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const save = messages.find(message => message.type === 'saveDocumentRevision');
  assert.ok(save?.type === 'saveDocumentRevision', 'Establish an in-flight save before final input');
  closing.localDraftChanged('one final input');
  closing.dispose();
  const recovery = messages.filter(message => message.type === 'draftChanged');
  assert.equal(recovery.at(-1)?.text, 'one final input', 'Closing recovery must not wait for the earlier save response');
  const count = messages.length;
  closing.accept({ type: 'saveDocumentRevisionResult', requestId: save.requestId,
    result: { ok: true, value: { revision: { version: 2, text: 'one earlier' } } } });
  await closing.whenIdle();
  assert.equal(messages.length, count, 'A late save response must not clear final recovery');
  assert.deepEqual(failures, []);
}

// When a remote save holds the ordinary queue, closing still has to fold every
// later accepted Session input in transport order.  Keeping only the newest
// local string would overwrite the Host revision with stale text.
for (const order of ['local-then-host', 'host-then-local'] as const) {
  const messages: WebviewToHostMessage[] = [], failures: unknown[] = [];
  const closing = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice: notice => { failures.push(notice); }, reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  closing.start(init); await closing.whenIdle();
  closing.localDraftChanged('one earlier'); await closing.whenIdle();
  closing.accept({ type: 'applied', version: 2 }); await closing.whenIdle();
  closing.requestSave();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.ok(messages.some(message => message.type === 'saveDocumentRevision'),
    `${order}: establish an in-flight save before queued state inputs`);

  const host = () => closing.accept({ type: 'docChanged', version: 3, text: 'One earlier' });
  const local = () => closing.localDraftChanged(
    order === 'local-then-host' ? 'one earlier local' : 'One earlier local'
  );
  if (order === 'local-then-host') { local(); host(); }
  else { host(); local(); }
  closing.dispose();

  const recovery = messages.filter(message => message.type === 'draftChanged');
  assert.equal(recovery.at(-1)?.text, 'One earlier local',
    `${order}: close recovery must match the ordered coordinator result`);
  assert.equal(recovery.at(-1)?.receiptVersion, 4,
    `${order}: Host and local receipts must both be consumed in order before recovery`);
  assert.deepEqual(failures, [], `${order}: closing handoff must not report an error`);
}

// A Host revision may be accepted before it can be presented while a real
// CodeMirror edit still describes the previous editor text. Both the normal
// queue and close handoff must rebase that edit instead of replacing Host text.
for (const closeImmediately of [false, true]) {
  const messages: WebviewToHostMessage[] = [], failures: unknown[] = [];
  const session = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice: notice => { failures.push(notice); }, reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  session.start({ ...init, text: 'abc', savedRevision: { version: 1, text: 'abc' } });
  session.requestSave();
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  const save = messages.find(message => message.type === 'saveDocumentRevision');
  assert.ok(save?.type === 'saveDocumentRevision');
  const before = Text.of(['abc']);
  const changes = ChangeSet.of([{ from: 3, to: 3, insert: '!' }], before.length);
  const edit = documentEdit(changes, before, changes.apply(before));
  session.accept({ type: 'docChanged', version: 2, text: 'Abc' });
  session.localDraftChanged(edit);
  if (closeImmediately) {
    session.dispose();
  } else {
    session.accept({ type: 'saveDocumentRevisionResult', requestId: save.requestId,
      result: { ok: true, value: { revision: { version: 1, text: 'abc' } } } });
    await session.whenIdle();
  }
  const recovery = messages.filter(message => message.type === 'draftChanged').at(-1);
  assert.deepEqual(recovery, {
    type: 'draftChanged', pageId, text: 'Abc!', baseVersion: 2,
    ...(closeImmediately ? { terminal: true } : {}), receiptVersion: 2
  }, `Host-first stale edit must rebase in ${closeImmediately ? 'close' : 'normal'} queue`);
  if (!closeImmediately) {
    assert.ok(messages.some(message => message.type === 'applyChanges'
      && message.baseVersion === 2 && message.changes[0]?.insert === '!'));
  }
  assert.deepEqual(failures, []);
}

// A true overlap is never recovered by replacing the newer Host document.
// The final receipt carries terminal conflict context for the real Host
// receiver, which preserves a conflict copy containing all three texts.
for (const closeImmediately of [false, true]) {
  const messages: WebviewToHostMessage[] = [], failures: unknown[] = [], copies: string[] = [];
  let applied = false;
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => ({ version: 2, text: 'ayc' }),
    applyDraft: async () => { applied = true; return true; },
    preserveConflict: async copy => {
      const index = copies.push(copy) - 1;
      return { replace: async text => { copies[index] = text; return true; } };
    }
  });
  const receiver = createDraftRecoveryReceiver(recovery, () => { throw new Error('complete conflict receipt expected'); });
  const session = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => {
      messages.push(message);
      if (message.type === 'draftChanged' || message.type === 'draftPatched') receiver.accept(message);
    },
    presentText() {}, restoreReloadedView() {}, showNotice: notice => { failures.push(notice); },
    reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  session.start({ ...init, text: 'abc', savedRevision: { version: 1, text: 'abc' } });
  session.requestSave();
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  const save = messages.find(message => message.type === 'saveDocumentRevision');
  assert.ok(save?.type === 'saveDocumentRevision');
  const before = Text.of(['abc']);
  const changes = ChangeSet.of([{ from: 1, to: 2, insert: 'x' }], before.length);
  const edit = documentEdit(changes, before, changes.apply(before));
  session.localDraftChanged(edit);
  session.accept({ type: 'docChanged', version: 2, text: 'ayc' });
  if (closeImmediately) {
    session.dispose();
  } else {
    session.accept({ type: 'saveDocumentRevisionResult', requestId: save.requestId,
      result: { ok: true, value: { revision: { version: 1, text: 'abc' } } } });
    await session.whenIdle();
  }
  const conflict = messages.filter(message => message.type === 'draftChanged').at(-1);
  assert.deepEqual(conflict, {
    type: 'draftChanged', pageId, text: 'axc', baseVersion: 1, conflictBaseText: 'abc',
    ...(closeImmediately ? { terminal: true } : {}), receiptVersion: 2
  }, `overlap must preserve terminal conflict context in ${closeImmediately ? 'close' : 'normal'} queue`);
  assert.equal(await recovery.recover(), true);
  assert.equal(applied, false, 'conflict recovery must not write over Host ayc');
  assert.match(copies.at(-1) ?? '', /axc/);
  assert.match(copies.at(-1) ?? '', /abc/);
  assert.match(copies.at(-1) ?? '', /ayc/);
  assert.deepEqual(failures, closeImmediately ? [] : ['external-conflict']);
}

// Normal recovery checkpoints remain compact, but the one beforeunload
// handoff is deliberately a complete terminal snapshot so it can survive more
// than one iframe replacement without an old patch checkpoint.
{
  const base = 'large close checkpoint\n'.repeat(14_000);
  const checkpoint = base + 'saved checkpoint';
  const finalText = checkpoint + '!';
  let recovered = '';
  let hostRevision = { version: 2, text: checkpoint };
  const recovery = createPendingDraftRecovery({
    readCurrentRevision: () => hostRevision,
    applyDraft: async (_expected, text) => {
      recovered = text;
      hostRevision = { version: hostRevision.version + 1, text };
      return true;
    },
    preserveConflict: async () => false
  });
  const receiver = createDraftRecoveryReceiver(recovery, () => {
    throw new Error('The close handoff must have a usable checkpoint');
  });
  const messages: WebviewToHostMessage[] = [], failures: unknown[] = [];
  const closing = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => {
      messages.push(message);
      if (message.type === 'draftChanged' || message.type === 'draftPatched') receiver.accept(message);
    },
    presentText() {}, restoreReloadedView() {}, showNotice: notice => { failures.push(notice); },
    reportUnexpectedError: (_, error) => { failures.push(error); }
  });
  closing.start({ ...init, text: base, savedRevision: { version: 1, text: base } });
  await closing.whenIdle();
  closing.localDraftChanged(checkpoint); await closing.whenIdle();
  closing.accept({ type: 'applied', version: 2 }); await closing.whenIdle();
  closing.requestSave();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const save = messages.find(message => message.type === 'saveDocumentRevision');
  assert.ok(save?.type === 'saveDocumentRevision', 'large close needs an in-flight save');
  const before = Text.of(checkpoint.split('\n'));
  const changes = ChangeSet.of([{ from: before.length, to: before.length, insert: '!' }], before.length);
  const finalEdit = documentEdit(changes, before, changes.apply(before));
  closing.localDraftChanged(finalEdit);
  closing.dispose();
  const finalRecovery = messages.at(-1);
  assert.equal(finalRecovery?.type, 'draftChanged',
    'a large pending close edit must be independently recoverable after page replacement');
  assert.equal(finalRecovery?.terminal, true);
  assert.equal(finalRecovery?.text, finalText);
  assert.ok(typeof finalRecovery?.text === 'string' && finalRecovery.text.length > 262_144,
    'the one terminal close snapshot intentionally materializes the full pending document');
  assert.equal(messages.filter(message => message.type === 'draftChanged' && message.terminal === true).length, 1,
    'beforeunload materializes one full terminal transfer, not one per queued/late action');
  const count = messages.length;
  closing.accept({ type: 'saveDocumentRevisionResult', requestId: save.requestId,
    result: { ok: true, value: { revision: { version: 2, text: checkpoint } } } });
  await closing.whenIdle();
  assert.equal(messages.length, count, 'late save completion must not clear terminal close recovery');
  assert.equal(await recovery.recover(), true, 'the Host receiver must apply the terminal close snapshot');
  assert.equal(recovered, finalText);
  assert.deepEqual(failures, []);
}

{
  const messages: WebviewToHostMessage[] = [], failures: string[] = [];
  const closing = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {}, showNotice() {},
    reportUnexpectedError: context => { failures.push(context); }
  });
  closing.localDraftChanged('rejected before initialization'); await closing.whenIdle();
  assert.deepEqual(failures, ['local draft']);
  closing.start(init); await closing.whenIdle(); closing.dispose();
  assert.deepEqual(messages, [], 'A rejected earlier input must not turn a newly initialized clean document into a recovery draft');
}

// Even when the latest ordinary recovery was already posted, beforeunload
// emits one complete terminal retry for bridge-in-flight delivery. Repeated
// disposal must not rematerialize it again.
{
  const messages: WebviewToHostMessage[] = [];
  const closing = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice() {}, reportUnexpectedError: (_context, error) => { throw error; }
  });
  closing.start(init);
  closing.localDraftChanged('already posted local draft');
  await closing.whenIdle();
  const ordinary = messages.find(message => message.type === 'draftChanged' && message.text === 'already posted local draft');
  assert.equal(ordinary?.terminal, undefined);
  closing.dispose();
  closing.dispose();
  const terminal = messages.filter(message => message.type === 'draftChanged' && message.terminal === true);
  assert.deepEqual(terminal, [{
    type: 'draftChanged', pageId, text: 'already posted local draft', baseVersion: 1, terminal: true, receiptVersion: 1
  }], 'teardown emits one full terminal retry and repeated dispose does not duplicate it');
}

{
  const messages: WebviewToHostMessage[] = [];
  const native = createDocumentSessionWebviewAdapter({
    pageId, postMessage: message => messages.push(message), presentText: () => true,
    restoreReloadedView: () => undefined, showNotice: () => undefined,
    reportUnexpectedError: (context, error) => { throw new Error(`${context}: ${String(error)}`); }
  });
  native.start(init);
  await native.whenIdle();
  const source = Text.of(['one']);
  const changes = ChangeSet.of({ from: 3, insert: ' native' }, source.length);
  native.localRecoveryDraftChanged(documentSnapshotFromString('one'), documentEdit(changes, source, changes.apply(source)));
  await native.whenIdle();
  native.accept({ type: 'docChanged', version: 2, text: 'one native' });
  await native.whenIdle();
  assert.equal(messages.filter(message => message.type === 'draftChanged').at(-1)?.text, null,
    'Host convergence must clear the recovery encoder checkpoint');
  native.accept({ type: 'docChanged', version: 3, text: 'different Host source' });
  await native.whenIdle();
  native.dispose();
  assert.equal(messages.some(message => message.type === 'draftChanged'
    && message.terminal === true && message.text === 'one native'), false,
  'Dispose after a later Host revision must not resend the accepted native text');
}

{
  const messages: WebviewToHostMessage[] = [];
  let fail = true;
  const native = createDocumentSessionWebviewAdapter({
    pageId, postMessage: message => messages.push(message), presentText: () => !fail,
    restoreReloadedView: () => undefined, showNotice: () => undefined,
    reportUnexpectedError: (context, error) => { throw new Error(`${context}: ${String(error)}`); }
  });
  native.start(init);
  await native.whenIdle();
  const source = Text.of(['one']);
  const changes = ChangeSet.of({ from: 3, insert: ' native' }, source.length);
  native.localRecoveryDraftChanged(documentSnapshotFromString('one'), documentEdit(changes, source, changes.apply(source)));
  await native.whenIdle();
  native.accept({ type: 'docChanged', version: 2, text: 'one native' });
  await native.whenIdle();
  assert.equal(messages.filter(message => message.type === 'draftChanged').at(-1)?.text, null);
  fail = false;
  assert.equal(await native.retryPresentation(), true,
    'The production runtime must retain retry after Host convergence clears recovery');
  assert.equal(messages.some(message => message.type === 'applyChanges'), false,
    'Retrying accepted native text must not submit an old-source edit');
  native.dispose();
}

// Recovery-only native table input crosses the normal recovery encoder but
// never submits an applyChanges operation or changes the session's document.
{
  const messages: WebviewToHostMessage[] = [];
  const native = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); }, presentText() {}, restoreReloadedView() {},
    showNotice() {}, reportUnexpectedError: (_context, error) => { throw error; }
  });
  native.start(init);
  const source = Text.of(['one']);
  const changes = ChangeSet.of({ from: 3, to: 3, insert: ' native' }, source.length);
  native.localRecoveryDraftChanged(documentSnapshotFromString('one'), documentEdit(changes, source, changes.apply(source)));
  await native.whenIdle();
  assert.deepEqual(messages, [{
    type: 'draftChanged', pageId, text: 'one native', baseVersion: 1, receiptVersion: 1
  }]);
  assert.equal(native.readCurrentText()?.toString(), 'one',
    'recovery-only input must not become a submit-able Document Session Draft');
  native.dispose();
  assert.deepEqual(messages.at(-1), {
    type: 'draftChanged', pageId, text: 'one native', baseVersion: 1, terminal: true, receiptVersion: 1
  }, 'dispose retains the latest native recovery projection');
}

// An external overlap promotes the native projection to the existing conflict
// Draft. Its locally presented source, recovery metadata and close handoff
// must stay together; the Host revision is never applied over by this path.
{
  const messages: WebviewToHostMessage[] = [];
  const presentations: Array<{ text: string; source: string }> = [];
  const notices: string[] = [];
  const native = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: message => { messages.push(message); },
    presentText: (text, source) => { presentations.push({ text, source }); },
    restoreReloadedView() {}, showNotice: notice => { notices.push(notice); }, reportUnexpectedError: (_context, error) => { throw error; }
  });
  native.start({ ...init, text: 'abc', savedRevision: { version: 1, text: 'abc' } });
  const source = Text.of(['abc']);
  const changes = ChangeSet.of({ from: 1, to: 2, insert: 'x' }, source.length);
  native.localRecoveryDraftChanged(documentSnapshotFromString('abc'), documentEdit(changes, source, changes.apply(source)));
  native.accept({ type: 'docChanged', version: 2, text: 'ayc' });
  await native.whenIdle();
  assert.deepEqual(presentations.at(-1), { text: 'axc', source: 'rebased-draft' },
    'a conflicting native projection must present the coordinator Draft, not leave stale Host text editable');
  const conflict = messages.filter(message => message.type === 'draftChanged').at(-1);
  assert.deepEqual(conflict, {
    type: 'draftChanged', pageId, text: 'axc', baseVersion: 2, conflictBaseText: 'abc', receiptVersion: 2
  });
  assert.deepEqual(notices, ['external-conflict']);
  assert.equal(messages.some(message => message.type === 'applyChanges'), false,
    'a conflicting native projection must not overwrite the external Host revision');
  native.dispose();
  assert.deepEqual(messages.at(-1), {
    type: 'draftChanged', pageId, text: 'axc', baseVersion: 2, conflictBaseText: 'abc', terminal: true, receiptVersion: 2
  }, 'terminal recovery must retain conflict metadata after native overlap');
}

console.log('Document Session Webview Adapter checks passed');
