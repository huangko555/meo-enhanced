import { parentPort } from 'node:worker_threads';
import { renderPreviewDocument } from './runtime';
import { createPreviewDocument } from './previewDocument';
import type { PreviewWorkerRequest, PreviewWorkerResponse } from '../host/previewRenderWorker';

if (!parentPort) throw new Error('Preview renderer requires a worker port');
const documents = new Map<string, { owner: string; characters: number; document: ReturnType<typeof createPreviewDocument> }>();
const documentKey = (owner: string, id: string) => `${owner.length}:${owner}${id}`;
parentPort.on('message', async (request: PreviewWorkerRequest) => {
  let response: PreviewWorkerResponse;
  try {
    if (request.kind === 'render') response = { id: request.id, value: renderPreviewDocument(request.options) };
    else if (request.kind === 'release') {
      for (const [key, entry] of documents) if (entry.owner === request.owner) {
        entry.document.dispose(); documents.delete(key);
      }
      response = { id: request.id, value: null };
    } else if (request.kind === 'open') {
      const key = documentKey(request.owner, request.documentId);
      documents.get(key)?.document.dispose(); documents.delete(key);
      const document = createPreviewDocument(request.documentId, request.options);
      const value = document.open(request.anchorLine);
      documents.set(key, { owner: request.owner, characters: request.options.markdownText.length, document });
      let characters = [...documents.values()].reduce((sum, entry) => sum + entry.characters, 0);
      while ((characters > 4 * 1024 * 1024 || documents.size > 4) && documents.size > 1) {
        const oldest = documents.keys().next().value!;
        const entry = documents.get(oldest)!;
        characters -= entry.characters; entry.document.dispose(); documents.delete(oldest);
      }
      response = { id: request.id, value };
    } else {
      const key = documentKey(request.owner, request.documentId);
      const entry = documents.get(key);
      if (!entry) throw new Error('Preview document expired');
      documents.delete(key); documents.set(key, entry);
      response = { id: request.id, value: await entry.document.run(request.operation) };
    }
  }
  catch (error) { response = { id: request.id, error: error instanceof Error ? error.message : String(error) }; }
  parentPort!.postMessage(response);
});
