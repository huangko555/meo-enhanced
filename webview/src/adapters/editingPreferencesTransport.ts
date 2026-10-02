import { createRequestPrefix } from './requestIdentity';
import { EDITING_PREFERENCES_TIMEOUT_MS, type UpdateEditingPreferencesRequest, type UpdatedEditingPreferencesResponse } from '../../../src/protocol/editingPreferences';
import type { EditingPreferencesChange } from '../../../src/foundation/editingPreferences';

export function createEditingPreferencesTransport(options: {
  readonly onSnapshot?: (preferences: import('../../../src/foundation/editingPreferences').EditingPreferences, revision: number) => void;
  readonly post: (request: UpdateEditingPreferencesRequest) => void;
  readonly schedule?: (callback: () => void, delay: number) => unknown;
  readonly cancel?: (timer: unknown) => void;
  readonly requestPrefix?: string;
}) {
  const schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const prefix = options.requestPrefix ?? createRequestPrefix();
  const pending = new Map<string, { resolve: (result: UpdatedEditingPreferencesResponse['result']) => void; timer: unknown }>();
  let sequence = 0;
  let disposed = false;
  const fail = (requestId: string, message: string, code: 'timeout' | 'operation-failed' = 'operation-failed') => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId); cancel(request.timer);
    request.resolve({ ok: false, error: { code, message } });
  };
  return {
    update(change: EditingPreferencesChange): Promise<UpdatedEditingPreferencesResponse['result']> {
      if (disposed) return Promise.resolve({ ok: false, error: { code: 'operation-failed', message: 'Settings window is closed' } });
      const requestId = `${prefix}-${++sequence}`;
      const result = new Promise<UpdatedEditingPreferencesResponse['result']>(resolve => {
        const timer = schedule(() => fail(requestId, 'Timed out saving settings', 'timeout'), EDITING_PREFERENCES_TIMEOUT_MS);
        pending.set(requestId, { resolve, timer });
      });
      try { options.post({ type: 'updateEditingPreferences', requestId, change }); }
      catch (error) { fail(requestId, error instanceof Error ? error.message : 'Unable to save settings'); }
      return result;
    },
    accept(response: UpdatedEditingPreferencesResponse): boolean {
      const request = pending.get(response.requestId);
      if (!request) return false;
      pending.delete(response.requestId); cancel(request.timer);
      if (response.result.ok) options.onSnapshot?.(response.result.value, response.revision);
      request.resolve(response.result); return true;
    },
    dispose() {
      disposed = true;
      for (const requestId of pending.keys()) fail(requestId, 'Editor closed before settings were saved');
    }
  };
}
