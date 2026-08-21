import assert from 'node:assert/strict';
import { createDocumentSessionCoordinator } from '../src/application/documentSession';
import { createDocumentSessionActionAdapter } from '../webview/src/adapters/documentSessionActions';

const createCoordinator = () => createDocumentSessionCoordinator({
  documentId: 'file:///actions.md',
  revision: { number: 3, text: 'accepted' },
  savedRevision: { revisionNumber: 3, text: 'accepted' }
});

{
  const messages: unknown[] = [];
  const presentations: Array<{ text: string; source: string }> = [];
  const adapter = createDocumentSessionActionAdapter({
    postMessage: (message) => messages.push(message),
    presentText: (text, source) => {
      presentations.push({ text, source });
      return true;
    },
    executeRemote: async () => {
      throw new Error('Unexpected remote action');
    },
    handleInput: () => [],
    showFailureNotice: () => undefined
  });

  await adapter.execute([
    { type: 'rememberDraft', text: 'local draft', receiptVersion: 1 },
    {
      type: 'applyTextChange',
      baseVersion: 3,
      changes: [{ from: 0, to: 8, insert: 'local draft' }]
    },
    { type: 'presentText', text: 'remote', source: 'revision' }
  ]);

  assert.deepEqual(messages, [
    { type: 'draftChanged', text: 'local draft', receiptVersion: 1 },
    {
      type: 'applyChanges',
      baseVersion: 3,
      changes: [{ from: 0, to: 8, insert: 'local draft' }]
    }
  ]);
  assert.deepEqual(presentations, [{ text: 'remote', source: 'revision' }]);
}

{
  const coordinator = createCoordinator();
  const messages: unknown[] = [];
  const notices: string[] = [];
  let revisionRequests = 0;
  const adapter = createDocumentSessionActionAdapter({
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
    showFailureNotice: (message) => notices.push(message)
  });

  await adapter.execute(coordinator.handle({
    type: 'localDraftChanged', text: 'newer draft', receiptVersion: 1
  }));
  await adapter.execute(coordinator.handle({
    type: 'hostRevisionChanged',
    version: 3,
    text: 'contradiction'
  }));

  assert.equal(revisionRequests, 2);
  assert.deepEqual(messages, [{ type: 'draftChanged', text: 'newer draft', receiptVersion: 1 }]);
  assert.deepEqual(notices, ['Could not resynchronize the document. Local edits were kept.']);
}

{
  const coordinator = createCoordinator();
  const presentations: string[] = [];
  let revisionRequests = 0;
  const adapter = createDocumentSessionActionAdapter({
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
    showFailureNotice: () => undefined
  });

  await adapter.execute(coordinator.handle({
    type: 'localDraftChanged', text: 'latest local edit', receiptVersion: 1
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
    postMessage: () => undefined,
    presentText: () => true,
    executeRemote: async () => {
      revisionRequests += 1;
      return { type: 'hostRevisionChanged', version: 3, text: `contradiction ${revisionRequests}` };
    },
    handleInput: (input) => coordinator.handle(input),
    showFailureNotice: (message) => notices.push(message)
  });

  await adapter.execute([{ type: 'requestRevision' }]);

  assert.equal(revisionRequests, 2);
  assert.deepEqual(notices, ['Could not resynchronize the document. Local edits were kept.']);
}

console.log('Document Session action adapter checks passed');
