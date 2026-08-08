import {
  createDocumentSessionCoordinator,
  type DocumentSessionAction,
  type DocumentSessionInput
} from '../../../src/application/documentSession';
import {
  DOCUMENT_SESSION_REQUEST_TIMEOUT_MS,
  type DocumentRevisionRequest,
  type DocumentRevisionResponse,
  type DocumentRevisionValue,
  type SaveDocumentRevisionRequest,
  type SaveDocumentRevisionResponse
} from '../../../src/protocol/documentSession';
import type { InitMessage } from '../../../src/protocol/readyInit';
import { createRequestLifecycle, type RequestLifecycleOptions } from './requestLifecycle';

type RemoteDocumentSessionAction = Extract<
  DocumentSessionAction,
  { readonly type: 'saveDocument' | 'requestRevision' }
>;

export type DocumentSessionTransport = {
  execute(action: RemoteDocumentSessionAction): Promise<DocumentSessionInput>;
  accept(response: SaveDocumentRevisionResponse | DocumentRevisionResponse): boolean;
  cancelAll(message?: string): void;
};

export function createDocumentSessionCoordinatorFromInit(message: InitMessage) {
  const normalize = (text: string): string => text.replace(/\r\n/g, '\n');
  return createDocumentSessionCoordinator({
    documentId: message.documentId,
    revision: { number: message.version, text: normalize(message.text) },
    savedRevision: message.savedRevision === null
      ? null
      : {
          revisionNumber: message.savedRevision.version,
          text: normalize(message.savedRevision.text)
        }
  });
}

export function createDocumentSessionTransport(
  postMessage: (message: SaveDocumentRevisionRequest | DocumentRevisionRequest) => void,
  options: RequestLifecycleOptions = {}
): DocumentSessionTransport {
  const saveLifecycle = createRequestLifecycle<DocumentRevisionValue>(
    'document-save',
    DOCUMENT_SESSION_REQUEST_TIMEOUT_MS,
    options
  );
  const revisionLifecycle = createRequestLifecycle<DocumentRevisionValue>(
    'document-revision',
    DOCUMENT_SESSION_REQUEST_TIMEOUT_MS,
    options
  );

  return {
    async execute(action) {
      if (action.type === 'saveDocument') {
        const expected = { version: action.revision.number, text: action.revision.text };
        const result = await saveLifecycle.start(
          (requestId) => postMessage({
            type: 'saveDocumentRevision',
            requestId,
            revision: expected
          }),
          {
            timeout: 'Timed out while saving the document Revision',
            sendFailed: 'Failed to request saving the document Revision'
          }
        );
        if (result.ok === false) {
          return {
            type: 'hostSaveFailed',
            version: expected.version,
            text: expected.text,
            message: result.error.message
          };
        }
        const saved = result.value.revision;
        if (saved.version !== expected.version || saved.text !== expected.text) {
          return {
            type: 'hostSaveFailed',
            version: expected.version,
            text: expected.text,
            message: 'Host confirmed a different document Revision'
          };
        }
        return { type: 'hostSaveSucceeded', version: saved.version, text: saved.text };
      }

      const result = await revisionLifecycle.start(
        (requestId) => postMessage({ type: 'requestDocumentRevision', requestId }),
        {
          timeout: 'Timed out while requesting the current document Revision',
          sendFailed: 'Failed to request the current document Revision'
        }
      );
      if (result.ok === false) {
        return { type: 'hostRevisionRequestFailed', message: result.error.message };
      }
      return {
        type: 'hostRevisionChanged',
        version: result.value.revision.version,
        text: result.value.revision.text
      };
    },
    accept(response) {
      return response.type === 'saveDocumentRevisionResult'
        ? saveLifecycle.accept(response.requestId, response.result)
        : revisionLifecycle.accept(response.requestId, response.result);
    },
    cancelAll(message = 'Document Session request canceled') {
      saveLifecycle.cancelAll(message);
      revisionLifecycle.cancelAll(message);
    }
  };
}
