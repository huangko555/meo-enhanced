import { isEditingPreferences, isEditingPreferencesChange, type EditingPreferences, type EditingPreferencesChange } from '../foundation/editingPreferences';
import { decodeRequestResult, type RequestResult } from './requestResult';

export const EDITING_PREFERENCES_TIMEOUT_MS = 10_000;
export type UpdateEditingPreferencesRequest = {
  readonly type: 'updateEditingPreferences';
  readonly requestId: string;
  readonly change: EditingPreferencesChange;
};
export type UpdatedEditingPreferencesResponse = {
  readonly type: 'updatedEditingPreferences';
  readonly requestId: string;
  readonly revision: number;
  readonly result: RequestResult<EditingPreferences>;
};
export type EditingPreferencesChangedEvent = { readonly type: 'editingPreferencesChanged'; readonly preferences: EditingPreferences; readonly revision: number };

function revision(value: unknown): number | null { return value === undefined ? 0 : Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }

export function decodeUpdateEditingPreferencesRequest(value: unknown): UpdateEditingPreferencesRequest | null {
  return isRecord(value) && value.type === 'updateEditingPreferences' && typeof value.requestId === 'string'
    && value.requestId.length > 0 && value.requestId.length <= 100 && isEditingPreferencesChange(value.change)
    ? { type: value.type, requestId: value.requestId, change: value.change } : null;
}

export function decodeUpdatedEditingPreferencesResponse(value: unknown): UpdatedEditingPreferencesResponse | null {
  if (!isRecord(value) || value.type !== 'updatedEditingPreferences' || typeof value.requestId !== 'string' || !value.requestId) return null;
  const version = revision(value.revision);
  if (version === null) return null;
  const result = decodeRequestResult(value.result, candidate => isEditingPreferences(candidate) ? candidate : null);
  return result ? { type: value.type, requestId: value.requestId, revision: version, result } : null;
}

export function decodeEditingPreferencesChangedEvent(value: unknown): EditingPreferencesChangedEvent | null {
  return isRecord(value) && value.type === 'editingPreferencesChanged' && isEditingPreferences(value.preferences) && revision(value.revision) !== null
    ? { type: value.type, preferences: value.preferences, revision: revision(value.revision)! } : null;
}
