import type { DocumentCopyResponse, DocumentCopyResult, SaveDocumentCopyRequest } from '../../../src/protocol/documentCopy';
import { DOCUMENT_COPY_TIMEOUT_MS } from '../../../src/protocol/documentCopy';
import { createRequestLifecycle, type RequestLifecycleOptions } from './requestLifecycle';
import type { UiLanguage } from '../application/uiLanguage';

export type DocumentCopyTransport = {
  save(): Promise<DocumentCopyResult>;
  accept(response: DocumentCopyResponse): boolean;
  dispose(): void;
};

export function createDocumentCopyTransport(
  dependencies: {
    readonly postMessage: (message: SaveDocumentCopyRequest) => void;
    readonly getUiLanguage: () => UiLanguage;
    readonly commitTransientEdits: () => void;
    readonly getCurrentText: () => string | null;
    readonly whenDocumentIdle: () => Promise<void>;
  },
  options: RequestLifecycleOptions = {}
): DocumentCopyTransport {
  const requests = createRequestLifecycle<{ readonly status: 'saved' | 'cancelled' }>(
    'document-copy', DOCUMENT_COPY_TIMEOUT_MS, options
  );
  let disposed = false;
  const label = (english: string, chinese: string): string => (
    dependencies.getUiLanguage() === 'zh-CN' ? chinese : english
  );

  return {
    async save() {
      if (disposed) return {
        ok: false,
        error: { code: 'operation-failed', message: label('The editor is closed.', '编辑器已关闭。') }
      };
      try {
        dependencies.commitTransientEdits();
        await dependencies.whenDocumentIdle();
        if (disposed) throw new Error(label('The editor closed before its content could be copied.', '编辑器已关闭，无法取得当前内容。'));
        const text = dependencies.getCurrentText();
        if (text === null) throw new Error(label('The current document content is unavailable.', '无法取得当前文档内容。'));
        // Reading the editor can commit an active table input. Drain its effects
        // before sending the captured snapshot to the Host.
        await dependencies.whenDocumentIdle();
        if (disposed) throw new Error(label('The editor closed before its content could be copied.', '编辑器已关闭，无法取得当前内容。'));
        return requests.start(
          (requestId) => dependencies.postMessage({ type: 'saveDocumentCopy', requestId, text }),
          {
            timeout: label('Timed out while waiting for the document copy operation.', '等待另存副本操作超时。'),
            sendFailed: label('Could not start saving the document copy.', '无法开始另存副本。')
          }
        );
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'operation-failed',
            message: error instanceof Error ? error.message : label('Could not collect the current document content.', '无法收集当前文档内容。')
          }
        };
      }
    },
    accept(response) {
      return requests.accept(response.requestId, response.result);
    },
    dispose() {
      disposed = true;
      requests.cancelAll(label('The editor closed before the document copy completed.', '编辑器已关闭，副本保存未完成。'));
    }
  };
}