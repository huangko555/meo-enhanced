import assert from 'node:assert/strict';
import {
  decodeDocumentRevisionRequest,
  decodeDocumentRevisionResponse,
  decodeSaveDocumentRevisionRequest,
  decodeSaveDocumentRevisionResponse
} from '../src/protocol/documentSession';
import {
  decodeHostToWebviewMessage,
  decodeWebviewToHostMessage
} from '../src/protocol/messages';
import { createDocumentSessionTransport } from '../webview/src/adapters/documentSessionTransport';
import { createDocumentSessionCoordinator } from '../src/application/documentSession';
import { respondToDocumentSessionRequest } from '../src/host/documentSessionRequestHandler';

const revision = { version: 4, text: 'accepted' };

const saveRequest = {
  type: 'saveDocumentRevision' as const,
  requestId: 'document-session-1',
  revision
};
assert.deepEqual(decodeSaveDocumentRevisionRequest(saveRequest), saveRequest);
assert.deepEqual(decodeWebviewToHostMessage(saveRequest), saveRequest);
assert.equal(decodeSaveDocumentRevisionRequest({ ...saveRequest, requestId: '' }), null);
assert.equal(decodeSaveDocumentRevisionRequest({
  ...saveRequest,
  revision: { version: null, text: 'accepted' }
}), null);

const saveSuccess = {
  type: 'saveDocumentRevisionResult' as const,
  requestId: 'document-session-1',
  result: { ok: true as const, value: { revision } }
};
assert.deepEqual(decodeSaveDocumentRevisionResponse(saveSuccess), saveSuccess);
assert.deepEqual(decodeHostToWebviewMessage(saveSuccess), saveSuccess);
assert.deepEqual(decodeSaveDocumentRevisionResponse({
  type: 'saveDocumentRevisionResult',
  requestId: 'document-session-2',
  result: { ok: false, error: { code: 'operation-failed', message: 'save failed' } }
}), {
  type: 'saveDocumentRevisionResult',
  requestId: 'document-session-2',
  result: { ok: false, error: { code: 'operation-failed', message: 'save failed' } }
});
assert.equal(decodeSaveDocumentRevisionResponse({
  ...saveSuccess,
  result: { ok: true, value: { revision: { version: -1, text: 'bad' } } }
}), null);

const revisionRequest = {
  type: 'requestDocumentRevision' as const,
  requestId: 'document-session-3'
};
assert.deepEqual(decodeDocumentRevisionRequest(revisionRequest), revisionRequest);
assert.deepEqual(decodeWebviewToHostMessage(revisionRequest), revisionRequest);
assert.equal(decodeDocumentRevisionRequest({ ...revisionRequest, requestId: '' }), null);

const revisionSuccess = {
  type: 'documentRevisionResult' as const,
  requestId: 'document-session-3',
  result: { ok: true as const, value: { revision } }
};
assert.deepEqual(decodeDocumentRevisionResponse(revisionSuccess), revisionSuccess);
assert.deepEqual(decodeHostToWebviewMessage(revisionSuccess), revisionSuccess);
assert.equal(decodeDocumentRevisionResponse({
  ...revisionSuccess,
  result: { ok: true, value: { revision: { version: 4, text: 7 } } }
}), null);
assert.equal(decodeHostToWebviewMessage({
  type: 'documentRevisionResult',
  requestId: 'invalid-result',
  result: { ok: true, value: { revision: { version: '4', text: 'bad' } } }
}), null);

const postedMessages: unknown[] = [];
const scheduledTimeouts: Array<() => void> = [];
const transport = createDocumentSessionTransport(
  (message) => { postedMessages.push(message); },
  {
    scheduleTimeout(callback) {
      scheduledTimeouts.push(callback);
      return callback;
    },
    cancelTimeout() {}
  }
);
const coordinator = createDocumentSessionCoordinator({
  documentId: 'file:///notes.md',
  revision: { number: 4, text: 'accepted' },
  savedRevision: { revisionNumber: 3, text: 'saved' }
});

const saveAction = coordinator.handle({ type: 'saveRequested' })[0];
assert.equal(saveAction?.type, 'saveDocument');
if (saveAction?.type !== 'saveDocument') throw new Error('Expected save action');
const saveInputPromise = transport.execute(saveAction);
const postedSave = postedMessages.at(-1) as { requestId: string };
assert.deepEqual(postedMessages.at(-1), {
  type: 'saveDocumentRevision',
  requestId: postedSave.requestId,
  revision: { version: 4, text: 'accepted' }
});
assert.equal(transport.accept({
  ...saveSuccess,
  requestId: 'unrelated'
}), false);
let saveCalls = 0;
const decodedSaveRequest = decodeWebviewToHostMessage(postedMessages.at(-1));
assert.equal(decodedSaveRequest?.type, 'saveDocumentRevision');
if (decodedSaveRequest?.type !== 'saveDocumentRevision') throw new Error('Expected decoded save request');
const hostSaveResponse = await respondToDocumentSessionRequest(decodedSaveRequest, {
  readRevision: () => revision,
  async saveRevision(expected) {
    saveCalls += 1;
    return { ok: true, value: { revision: expected } };
  }
});
const decodedSaveResponse = decodeHostToWebviewMessage(hostSaveResponse);
assert.equal(decodedSaveResponse?.type, 'saveDocumentRevisionResult');
if (decodedSaveResponse?.type !== 'saveDocumentRevisionResult') throw new Error('Expected decoded save response');
assert.equal(transport.accept(decodedSaveResponse), true);
assert.equal(saveCalls, 1);
const saveInput = await saveInputPromise;
assert.deepEqual(saveInput, {
  type: 'hostSaveSucceeded',
  version: 4,
  text: 'accepted'
});
assert.deepEqual(coordinator.handle(saveInput), []);
assert.equal(transport.accept({ ...saveSuccess, requestId: postedSave.requestId }), false);

const rejectedMismatchedSave = await respondToDocumentSessionRequest({
  type: 'saveDocumentRevision',
  requestId: 'mismatch',
  revision: { version: 3, text: 'stale' }
}, {
  readRevision: () => revision,
  async saveRevision() {
    throw new Error('must not save a mismatched Revision');
  }
});
assert.deepEqual(rejectedMismatchedSave, {
  type: 'saveDocumentRevisionResult',
  requestId: 'mismatch',
  result: {
    ok: false,
    error: { code: 'operation-failed', message: 'Document Revision changed before save' }
  }
});

let invalidRequestEnteredHost = false;
const invalidRequest = decodeWebviewToHostMessage({
  type: 'requestDocumentRevision',
  requestId: ''
});
if (invalidRequest?.type === 'requestDocumentRevision') {
  invalidRequestEnteredHost = true;
  await respondToDocumentSessionRequest(invalidRequest, {
    readRevision: () => revision,
    async saveRevision() { return { ok: false, error: { code: 'operation-failed', message: 'unused' } }; }
  });
}
assert.equal(invalidRequestEnteredHost, false);

const resyncActions = coordinator.handle({
  type: 'hostRevisionChanged',
  version: 4,
  text: 'contradiction'
});
assert.deepEqual(resyncActions, [{ type: 'requestRevision' }]);
const revisionInputPromise = transport.execute(resyncActions[0] as { type: 'requestRevision' });
const postedRevision = postedMessages.at(-1) as { requestId: string };
assert.deepEqual(postedMessages.at(-1), {
  type: 'requestDocumentRevision',
  requestId: postedRevision.requestId
});
assert.equal(transport.accept({
  type: 'saveDocumentRevisionResult',
  requestId: postedRevision.requestId,
  result: { ok: true, value: { revision: { version: 5, text: 'wrong response kind' } } }
}), false);
const decodedRevisionRequest = decodeWebviewToHostMessage(postedMessages.at(-1));
assert.equal(decodedRevisionRequest?.type, 'requestDocumentRevision');
if (decodedRevisionRequest?.type !== 'requestDocumentRevision') throw new Error('Expected decoded Revision request');
const hostRevisionResponse = await respondToDocumentSessionRequest(decodedRevisionRequest, {
  readRevision: () => ({ version: 5, text: 'authoritative' }),
  async saveRevision() { return { ok: false, error: { code: 'operation-failed', message: 'unused' } }; }
});
const decodedRevisionResponse = decodeHostToWebviewMessage(hostRevisionResponse);
assert.equal(decodedRevisionResponse?.type, 'documentRevisionResult');
if (decodedRevisionResponse?.type !== 'documentRevisionResult') throw new Error('Expected decoded Revision response');
assert.equal(transport.accept(decodedRevisionResponse), true);
const revisionInput = await revisionInputPromise;
assert.deepEqual(revisionInput, {
  type: 'hostRevisionChanged',
  version: 5,
  text: 'authoritative'
});
assert.deepEqual(coordinator.handle(revisionInput), [
  { type: 'presentText', text: 'authoritative', source: 'revision' }
]);

const earlierRevisionPromise = transport.execute({ type: 'requestRevision' });
const earlierRevisionId = (postedMessages.at(-1) as { requestId: string }).requestId;
const laterRevisionPromise = transport.execute({ type: 'requestRevision' });
const laterRevisionId = (postedMessages.at(-1) as { requestId: string }).requestId;
assert.equal(transport.accept({
  ...revisionSuccess,
  requestId: laterRevisionId,
  result: { ok: true, value: { revision: { version: 7, text: 'later response' } } }
}), true);
assert.equal(transport.accept({
  ...revisionSuccess,
  requestId: earlierRevisionId,
  result: { ok: true, value: { revision: { version: 6, text: 'earlier response' } } }
}), true);
assert.deepEqual(await laterRevisionPromise, {
  type: 'hostRevisionChanged', version: 7, text: 'later response'
});
assert.deepEqual(await earlierRevisionPromise, {
  type: 'hostRevisionChanged', version: 6, text: 'earlier response'
});

const failedSavePromise = transport.execute({
  type: 'saveDocument',
  revision: { number: 5, text: 'authoritative' }
});
const failedSaveId = (postedMessages.at(-1) as { requestId: string }).requestId;
assert.equal(transport.accept({
  type: 'saveDocumentRevisionResult',
  requestId: failedSaveId,
  result: { ok: false, error: { code: 'operation-failed', message: 'disk unavailable' } }
}), true);
assert.deepEqual(await failedSavePromise, {
  type: 'hostSaveFailed',
  version: 5,
  text: 'authoritative',
  message: 'disk unavailable'
});

const mismatchedSavePromise = transport.execute({
  type: 'saveDocument',
  revision: { number: 5, text: 'authoritative' }
});
const mismatchedSaveId = (postedMessages.at(-1) as { requestId: string }).requestId;
assert.equal(transport.accept({
  type: 'saveDocumentRevisionResult',
  requestId: mismatchedSaveId,
  result: { ok: true, value: { revision: { version: 6, text: 'different' } } }
}), true);
assert.deepEqual(await mismatchedSavePromise, {
  type: 'hostSaveFailed',
  version: 5,
  text: 'authoritative',
  message: 'Host confirmed a different document Revision'
});

const timedOutRevision = transport.execute({ type: 'requestRevision' });
const timedOutRequest = postedMessages.at(-1) as { requestId: string };
scheduledTimeouts.at(-1)?.();
assert.deepEqual(await timedOutRevision, {
  type: 'hostRevisionRequestFailed',
  message: 'Timed out while requesting the current document Revision'
});
assert.equal(transport.accept({
  ...revisionSuccess,
  requestId: timedOutRequest.requestId
}), false);

const canceledSave = transport.execute({
  type: 'saveDocument',
  revision: { number: 5, text: 'authoritative' }
});
transport.cancelAll('Document Session closed');
assert.deepEqual(await canceledSave, {
  type: 'hostSaveFailed',
  version: 5,
  text: 'authoritative',
  message: 'Document Session closed'
});

console.log('Document Session Protocol checks passed');
