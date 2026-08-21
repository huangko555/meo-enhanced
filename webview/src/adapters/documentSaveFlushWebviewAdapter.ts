import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/protocol/messages';
import type {
  FlushDocumentEditsRequest,
  FlushDocumentEditsResponse,
  FlushDocumentEditsResolution
} from '../../../src/protocol/documentSaveFlush';

export type DocumentSaveFlushWebviewAdapter = {
  accept(message: HostToWebviewMessage): boolean;
  dispose(): void;
};

export type DocumentSaveFlushWebviewAdapterDependencies = {
  readonly postMessage: (message: WebviewToHostMessage) => void;
  readonly commitTransientEdits: () => void;
  readonly getCurrentText: () => string;
  readonly whenDocumentIdle: () => Promise<void>;
};

const closedResult = (): FlushDocumentEditsResolution => ({
  ok: false,
  error: {
    code: 'operation-failed',
    message: 'The editor closed before pending changes could be prepared for save.'
  }
});

const failedResult = (error: unknown): FlushDocumentEditsResolution => ({
  ok: false,
  error: {
    code: 'operation-failed',
    message: error instanceof Error ? error.message : 'Failed to collect pending editor changes.'
  }
});

const MAX_COMPLETED_REQUESTS = 16;

/** Commits transient editor state, then crosses the Document Session idle seam once. */
export function createDocumentSaveFlushWebviewAdapter(
  dependencies: DocumentSaveFlushWebviewAdapterDependencies
): DocumentSaveFlushWebviewAdapter {
  const pending = new Set<string>();
  const completed = new Map<string, FlushDocumentEditsResponse>();
  let disposed = false;

  const remember = (response: FlushDocumentEditsResponse): void => {
    completed.set(response.requestId, response);
    while (completed.size > MAX_COMPLETED_REQUESTS) {
      const oldest = completed.keys().next().value;
      if (typeof oldest !== 'string') break;
      completed.delete(oldest);
    }
  };

  const respond = (requestId: string, result: FlushDocumentEditsResolution): void => {
    if (!pending.delete(requestId)) return;
    const response: FlushDocumentEditsResponse = {
      type: 'flushDocumentEditsResult',
      requestId,
      result
    };
    remember(response);
    dependencies.postMessage(response);
  };

  const run = (request: FlushDocumentEditsRequest): void => {
    pending.add(request.requestId);
    let text: string;
    let idle: Promise<void>;
    try {
      dependencies.commitTransientEdits();
      text = dependencies.getCurrentText();
      idle = dependencies.whenDocumentIdle();
    } catch (error) {
      respond(request.requestId, failedResult(error));
      return;
    }
    void idle.then(
      () => {
        if (disposed) return;
        respond(request.requestId, { ok: true, value: { text } });
      },
      (error) => respond(request.requestId, failedResult(error))
    );
  };

  return {
    accept(message) {
      if (message.type !== 'flushDocumentEdits') return false;
      const cached = completed.get(message.requestId);
      if (cached) {
        if (!disposed) dependencies.postMessage(cached);
        return true;
      }
      if (disposed || pending.has(message.requestId)) return true;
      run(message);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const requestId of Array.from(pending)) respond(requestId, closedResult());
      pending.clear();
      completed.clear();
    }
  };
}
