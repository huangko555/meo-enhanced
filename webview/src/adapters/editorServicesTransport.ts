import { createRequestPrefix } from './requestIdentity';
import type { EditorServiceRequest, EditorServiceResponse, EditorServiceValue } from '../../../src/protocol/editorServices';
export function createEditorServicesTransport(post: (request: EditorServiceRequest) => void) {
  const pending = new Map<string, { resolve: (value: EditorServiceValue | null) => void; timer: ReturnType<typeof setTimeout> }>();
  const prefix = createRequestPrefix(); let sequence = 0; let disposed = false;
  return {
    request(operation: Omit<Extract<EditorServiceRequest, { action: 'links' }>, 'type' | 'requestId'> | { action: 'readClipboard' } | { action: 'writeClipboard'; text: string }): Promise<EditorServiceValue | null> {
      if (disposed) return Promise.resolve(null);
      const requestId = `${prefix}-${++sequence}`;
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, 5000);
        pending.set(requestId, { resolve, timer });
        try { post({ type: 'editorService', requestId, ...operation }); }
        catch { clearTimeout(timer); pending.delete(requestId); resolve(null); }
      });
    },
    accept(message: EditorServiceResponse) {
      const entry = pending.get(message.requestId); if (!entry) return false;
      pending.delete(message.requestId); clearTimeout(entry.timer); entry.resolve(message.result.ok ? message.result.value : null); return true;
    },
    dispose() { disposed = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(null); } pending.clear(); }
  };
}
