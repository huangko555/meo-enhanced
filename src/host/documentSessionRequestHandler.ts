import type {
  DocumentRevisionDto,
  DocumentRevisionRequest,
  DocumentRevisionResolution,
  DocumentRevisionResponse,
  SaveDocumentRevisionRequest,
  SaveDocumentRevisionResponse
} from '../protocol/documentSession';

export type DocumentSessionHostAdapter = {
  readonly readRevision: () => DocumentRevisionDto | Promise<DocumentRevisionDto>;
  readonly saveRevision: (revision: DocumentRevisionDto) => Promise<DocumentRevisionResolution>;
};

export async function respondToDocumentSessionRequest(
  request: SaveDocumentRevisionRequest | DocumentRevisionRequest,
  adapter: DocumentSessionHostAdapter
): Promise<SaveDocumentRevisionResponse | DocumentRevisionResponse> {
  if (request.type === 'requestDocumentRevision') {
    try {
      const revision = await adapter.readRevision();
      return {
        type: 'documentRevisionResult',
        requestId: request.requestId,
        result: { ok: true, value: { revision } }
      };
    } catch (error) {
      return {
        type: 'documentRevisionResult',
        requestId: request.requestId,
        result: {
          ok: false,
          error: {
            code: 'operation-failed',
            message: error instanceof Error ? error.message : 'Failed to read the current document Revision'
          }
        }
      };
    }
  }

  try {
    const current = await adapter.readRevision();
    if (!sameRevision(current, request.revision)) {
      return saveFailure(request.requestId, 'Document Revision changed before save');
    }
    const result = await adapter.saveRevision(request.revision);
    if (result.ok && !sameRevision(result.value.revision, request.revision)) {
      return saveFailure(request.requestId, 'Host saved a different document Revision');
    }
    return { type: 'saveDocumentRevisionResult', requestId: request.requestId, result };
  } catch (error) {
    return saveFailure(
      request.requestId,
      error instanceof Error ? error.message : 'Failed to save the document Revision'
    );
  }
}

function sameRevision(left: DocumentRevisionDto, right: DocumentRevisionDto): boolean {
  return left.version === right.version && left.text === right.text;
}

function saveFailure(requestId: string, message: string): SaveDocumentRevisionResponse {
  return {
    type: 'saveDocumentRevisionResult',
    requestId,
    result: { ok: false, error: { code: 'operation-failed', message } }
  };
}
