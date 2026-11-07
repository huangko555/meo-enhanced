import assert from 'node:assert/strict';
import { createDocumentSessionCoordinator } from '../src/application/documentSession';
import { createDocumentSessionActionAdapter } from '../webview/src/adapters/documentSessionActions';

const createCoordinator = () => createDocumentSessionCoordinator({
  documentId: 'file:///actions.md',
  revision: { number: 3, text: 'accepted' },
  savedRevision: { revisionNumber: 3, text: 'accepted' }
});
const pageId = 'page_actions';

{
  const messages: unknown[] = [];
  const presentations: Array<{ text: string; source: string }> = [];
  const adapter = createDocumentSessionActionAdapter({
    pageId,
    postMessage: (message) => messages.push(message),
    presentText: (text, source) => {
      presentations.push({ text, source });
      return true;
    },
    executeRemote: async () => {
      throw new Error('Unexpected remote action');
    },
    handleInput: () => [],
    showNotice: () => undefined
  });

  await adapter.execute([
    { type: 'rememberDraft', text: 'local draft', baseVersion: 3, receiptVersion: 1 },
    {
      type: 'applyTextChange',
      baseVersion: 3,
      changes: [{ from: 0, to: 8, insert: 'local draft' }]
    },
    { type: 'presentText', text: 'remote', source: 'revision' }
  ]);

  assert.deepEqual(messages, [
    { type: 'draftChanged', pageId, text: 'local draft', baseVersion: 3, receiptVersion: 1 },
    {
      type: 'applyChanges',
      baseVersion: 3,
      changes: [{ from: 0, to: 8, insert: 'local draft' }]
    }
  ]);
  assert.deepEqual(presentations, [{ text: 'remote', source: 'revision' }]);
}

{
  const coordinator = createDocumentSessionCoordinator({
    documentId: 'file:///external-conflict.md',
    revision: { number: 3, text: 'one\ntwo' },
    savedRevision: { revisionNumber: 3, text: 'one\ntwo' }
  });
  const messages: unknown[] = [];
  const presentations: string[] = [];
  const notices: string[] = [];
  const adapter = createDocumentSessionActionAdapter({
    pageId,
    postMessage: (message) => messages.push(message),
    presentText: (text) => {
      presentations.push(text);
      return true;
    },
    executeRemote: async () => {
      throw new Error('Dirty Draft external conflict must not start a remote action');
    },
    handleInput: (input) => coordinator.handle(input),
    showNotice: (notice) => notices.push(notice)
  });

  await adapter.execute(coordinator.handle({ type: 'localDraftChanged', text: 'one\nlocal' }));
  await adapter.execute(coordinator.handle({ type: 'submitPendingDraft' }));
  const messagesBeforeExternal = messages.length;
  await adapter.execute(coordinator.handle({
    type: 'hostRevisionChanged',
    version: 4,
    text: 'one\nremote'
  }));
  await adapter.execute(coordinator.handle({
    type: 'hostRevisionChanged',
    version: 4,
    text: 'one\nremote'
  }));

  assert.deepEqual(presentations, [], 'dirty Draft must remain presented after an overlapping external update');
  assert.deepEqual(messages.slice(messagesBeforeExternal), [{
    type: 'draftChanged', pageId, text: 'one\nlocal', baseVersion: 3, conflictBaseText: 'one\ntwo', receiptVersion: 2
  }], 'external conflict must retain a terminal recovery candidate without resubmitting');
  assert.equal(coordinator.draftRecoveryReceiptVersion(), 2, 'terminal conflict must advance the Draft Recovery Receipt');
  assert.deepEqual(notices, [
    'external-conflict'
  ]);
}

{
  const messages: unknown[] = [];
  const adapter = createDocumentSessionActionAdapter({
    pageId,
    postMessage: message => messages.push(message),
    presentText: () => true,
    executeRemote: async () => { throw new Error('Unexpected remote action'); },
    handleInput: () => [],
    showNotice: () => undefined
  });
  adapter.preserveDraft({
    type: 'rememberDraft', text: 'local insertion', baseVersion: 7,
    conflictBaseText: '', receiptVersion: 1
  });
  assert.deepEqual(messages, [{
    type: 'draftChanged', pageId, text: 'local insertion', baseVersion: 7,
    conflictBaseText: '', terminal: true, receiptVersion: 1
  }], 'an empty original document remains explicit terminal conflict context');
}

{
  const coordinator = createCoordinator();
  const messages: unknown[] = [];
  const notices: string[] = [];
  let revisionRequests = 0;
  const adapter = createDocumentSessionActionAdapter({
    pageId,
    postMessage: (message) => messages.push(message),
    presentText: () => true,
    executeRemote: async (action) => {
      assert.equal(action.type, 'requestRevision');
      revisionRequests += 1;
      return {
        type: 'hostRevisionRequestFailed',
        message: `request failed ${revisionRequests}`
      };
    },
    handleInput: (input) => coordinator.handle(input),
    showNotice: (notice) => notices.push(notice)
  });

  await adapter.execute(coordinator.handle({
    type: 'localDraftChanged', text: 'newer draft'
  }));
  await adapter.execute(coordinator.handle({
    type: 'hostRevisionChanged',
    version: 3,
    text: 'contradiction'
  }));

  assert.equal(revisionRequests, 2);
  assert.deepEqual(messages, [{ type: 'draftChanged', pageId, text: 'newer draft', baseVersion: 3, receiptVersion: 1 }]);
  assert.deepEqual(notices, ['resync-failed']);
}

{
  const coordinator = createCoordinator();
  const presentations: string[] = [];
  let revisionRequests = 0;
  const adapter = createDocumentSessionActionAdapter({
    pageId,
    postMessage: () => undefined,
    presentText: (text) => {
      presentations.push(text);
      return true;
    },
    executeRemote: async () => {
      revisionRequests += 1;
      return { type: 'hostRevisionChanged', version: 2, text: 'late response' };
    },
    handleInput: (input) => coordinator.handle(input),
    showNotice: () => undefined
  });

  await adapter.execute(coordinator.handle({
    type: 'localDraftChanged', text: 'latest local edit'
  }));
  await adapter.execute([{ type: 'requestRevision' }]);

  assert.equal(revisionRequests, 1);
  assert.deepEqual(presentations, []);
}

{
  const coordinator = createCoordinator();
  const notices: string[] = [];
  let revisionRequests = 0;
  const adapter = createDocumentSessionActionAdapter({
    pageId,
    postMessage: () => undefined,
    presentText: () => true,
    executeRemote: async () => {
      revisionRequests += 1;
      return { type: 'hostRevisionChanged', version: 3, text: `contradiction ${revisionRequests}` };
    },
    handleInput: (input) => coordinator.handle(input),
    showNotice: (notice) => notices.push(notice)
  });

  await adapter.execute([{ type: 'requestRevision' }]);

  assert.equal(revisionRequests, 2);
  assert.deepEqual(notices, ['resync-failed']);
}

console.log('Document Session action adapter checks passed');
