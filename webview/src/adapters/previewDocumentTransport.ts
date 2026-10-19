import type { PreviewDocumentOperation, PreviewDocumentResult } from '../../../src/foundation/previewDocument';
import type { PreviewDocumentRequest, PreviewDocumentResponse } from '../../../src/protocol/previewDocument';
import { createRequestLifecycle } from './requestLifecycle';

/** Correlates block, search and copy requests with the parsed document that owns them. */
export function createPreviewDocumentTransport(post: (message: PreviewDocumentRequest) => void) {
  const lifecycle = createRequestLifecycle<PreviewDocumentResult>('preview-document', 15_000);
  const pending = new Map<string, { documentId: string; kind: PreviewDocumentOperation['kind'] }>();
  return {
    async request(documentId: string, operation: PreviewDocumentOperation): Promise<PreviewDocumentResult> {
      let id = '';
      try {
        const result = await lifecycle.start(requestId => {
          id = requestId;
          pending.set(id, { documentId, kind: operation.kind });
          post({ type: 'requestPreviewDocument', requestId, documentId, operation });
        }, { timeout: 'Preview document request timed out', sendFailed: 'Preview document request failed' });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      } finally { pending.delete(id); }
    },
    accept(message: PreviewDocumentResponse): boolean {
      const request = pending.get(message.requestId);
      if (!request || request.documentId !== message.documentId) return false;
      if (message.result.ok && message.result.value.kind !== request.kind) return lifecycle.accept(message.requestId,
        { ok: false, error: { code: 'operation-failed', message: 'Preview returned a different document operation' } });
      return lifecycle.accept(message.requestId, message.result);
    },
    cancel(keepCopy = true) {
      for (const [id, request] of pending) if (!keepCopy || request.kind !== 'copy') {
        pending.delete(id);
        lifecycle.accept(id, { ok: false, error: { code: 'operation-failed', message: 'Preview presentation changed' } });
      }
    }
  };
}
