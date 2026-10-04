import { IMAGE_LOCATION_TIMEOUT_MS, type ImageLocationRequest, type ImageLocationResponse } from '../../../src/protocol/imageStorage';

type Request = Omit<Extract<ImageLocationRequest, { action: 'read' | 'selectFolder' }>, 'type' | 'requestId'>
  | Omit<Extract<ImageLocationRequest, { action: 'preview' | 'save' }>, 'type' | 'requestId'>;

export function createImageStorageTransport(post: (request: ImageLocationRequest) => void) {
  const session = [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-');
  let counter = 0;
  let disposed = false;
  const pending = new Map<string, { resolve: (result: ImageLocationResponse['result']) => void; timer: ReturnType<typeof setTimeout> }>();
  const failure = (message: string): ImageLocationResponse['result'] => ({ ok: false, error: { code: 'operation-failed', message } });
  return {
    request(request: Request): Promise<ImageLocationResponse['result']> {
      if (disposed) return Promise.resolve(failure('Image settings are closed.'));
      const requestId = 'image-location-' + session + '-' + counter++;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, error: { code: 'timeout', message: 'Image settings request timed out.' } });
        }, request.action === 'selectFolder' ? 120000 : IMAGE_LOCATION_TIMEOUT_MS);
        pending.set(requestId, { resolve, timer });
        try { post({ ...request, type: 'imageLocation', requestId }); }
        catch (error) { clearTimeout(timer); pending.delete(requestId); resolve(failure(String(error))); }
      });
    },
    accept(response: ImageLocationResponse) {
      const request = pending.get(response.requestId);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(response.requestId); request.resolve(response.result);
    },
    dispose() {
      disposed = true;
      for (const request of pending.values()) { clearTimeout(request.timer); request.resolve(failure('Image settings are closed.')); }
      pending.clear();
    }
  };
}
