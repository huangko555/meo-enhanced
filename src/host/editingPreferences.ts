import { normalizeEditingPreferences, changeEditingPreferences, type ShortcutPlatform } from '../application/editingPreferences';
import type { EditingPreferences } from '../foundation/editingPreferences';
import type { UpdateEditingPreferencesRequest, UpdatedEditingPreferencesResponse } from '../protocol/editingPreferences';

export const EDITING_PREFERENCES_SETTING = 'editing.preferences';

/** Serializes read/merge/write against the Host configuration owner across panels. */
export function createEditingPreferencesHost(options: {
  readonly read: () => unknown;
  readonly write: (preferences: EditingPreferences) => Promise<void>;
  readonly platform: ShortcutPlatform;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  const completed = new Map<string, { payload: string; response: Promise<UpdatedEditingPreferencesResponse> }>();
  let revision = 0;
  let signature = '';
  const snapshot = () => {
    const preferences = normalizeEditingPreferences(options.read());
    const next = JSON.stringify(preferences);
    if (signature && next !== signature) revision++;
    signature = next;
    return { preferences, revision };
  };
  return {
    read: () => snapshot().preferences,
    snapshot,
    update(request: UpdateEditingPreferencesRequest): Promise<UpdatedEditingPreferencesResponse> {
      const previous = completed.get(request.requestId);
      if (previous) return previous.payload === JSON.stringify(request.change) ? previous.response : Promise.resolve({ type: 'updatedEditingPreferences', requestId: request.requestId, revision: snapshot().revision, result: { ok: false, error: { code: 'operation-failed', message: 'Request ID reused with a different change' } } });
      const response = tail.then(async (): Promise<UpdatedEditingPreferencesResponse> => {
        try {
          const preferences = changeEditingPreferences(snapshot().preferences, request.change, options.platform);
          await options.write(preferences);
          const current = snapshot();
          return { type: 'updatedEditingPreferences', requestId: request.requestId, revision: current.revision, result: { ok: true, value: current.preferences } };
        } catch (error) {
          return { type: 'updatedEditingPreferences', requestId: request.requestId, revision: snapshot().revision, result: {
            ok: false, error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Unable to save editing preferences' }
          } };
        }
      });
      tail = response;
      completed.set(request.requestId, { payload: JSON.stringify(request.change), response });
      if (completed.size > 128) completed.delete(completed.keys().next().value!);
      return response;
    }
  };
}
