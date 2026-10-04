import { decodeImageLocationState, decodeImageStorage, type ImageLocationState, type ImageStoragePreferences } from '../foundation/imageStorage';
import { decodeRequestResult, type RequestResult } from './requestResult';

export const IMAGE_LOCATION_TIMEOUT_MS = 15000;
export type ImageLocationRequest = { readonly type: 'imageLocation'; readonly requestId: string }
  & ({ readonly action: 'read' | 'selectFolder' }
    | { readonly action: 'preview' | 'save'; readonly preferences: ImageStoragePreferences });
export type ImageLocationResponse = {
  readonly type: 'imageLocationResult'; readonly requestId: string;
  readonly result: RequestResult<{ readonly state: ImageLocationState; readonly selectedFolder: string | null }>;
};
export type ImageStorageChangedEvent = { readonly type: 'imageStorageChanged' };

export function decodeImageLocationRequest(value: unknown): ImageLocationRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'imageLocation' || typeof candidate.requestId !== 'string'
    || !candidate.requestId || candidate.requestId.length > 200) return null;
  if (candidate.action === 'read' || candidate.action === 'selectFolder') return { type: candidate.type, requestId: candidate.requestId, action: candidate.action };
  const preferences = decodeImageStorage(candidate.preferences);
  if (!preferences || (candidate.action !== 'preview' && candidate.action !== 'save')) return null;
  return { type: candidate.type, requestId: candidate.requestId, action: candidate.action, preferences };
}

export function decodeImageLocationResponse(value: unknown): ImageLocationResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'imageLocationResult' || typeof candidate.requestId !== 'string' || !candidate.requestId) return null;
  const result = decodeRequestResult(candidate.result, value => {
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as Record<string, unknown>;
    const state = decodeImageLocationState(candidate.state);
    if (!state || (candidate.selectedFolder !== null && typeof candidate.selectedFolder !== 'string')) return null;
    return { state, selectedFolder: candidate.selectedFolder };
  });
  return result ? { type: candidate.type, requestId: candidate.requestId, result } : null;
}

export function decodeImageStorageChangedEvent(value: unknown): ImageStorageChangedEvent | null {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'imageStorageChanged'
    ? { type: 'imageStorageChanged' } : null;
}
