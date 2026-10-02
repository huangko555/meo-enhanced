import { decodeRequestResult, type RequestResult } from './requestResult';
export type LinkCandidate = { readonly label: string; readonly insert: string; readonly detail: string; readonly anchor?: string };
export type EditorServiceRequest = { readonly type: 'editorService'; readonly requestId: string } & (
  | { readonly action: 'readClipboard' }
  | { readonly action: 'writeClipboard'; readonly text: string }
  | { readonly action: 'links'; readonly kind: 'documents' | 'paths' | 'headings'; readonly query: string; readonly target: string }
);
export type EditorServiceValue = { readonly text: string } | { readonly candidates: readonly LinkCandidate[] };
export type EditorServiceResponse = { readonly type: 'editorServiceResult'; readonly requestId: string; readonly result: RequestResult<EditorServiceValue> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function decodeEditorServiceRequest(value: unknown): EditorServiceRequest | null {
  if (!record(value) || value.type !== 'editorService' || typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > 100) return null;
  if (value.action === 'readClipboard') return { type: value.type, requestId: value.requestId, action: value.action };
  if (value.action === 'writeClipboard' && typeof value.text === 'string' && value.text.length <= 5_000_000) return { type: value.type, requestId: value.requestId, action: value.action, text: value.text };
  if (value.action === 'links' && ['documents', 'paths', 'headings'].includes(String(value.kind)) && typeof value.query === 'string' && value.query.length <= 200 && typeof value.target === 'string' && value.target.length <= 500) return { type: value.type, requestId: value.requestId, action: value.action, kind: value.kind as 'documents' | 'paths' | 'headings', query: value.query, target: value.target };
  return null;
}
export function decodeEditorServiceResponse(value: unknown): EditorServiceResponse | null {
  if (!record(value) || value.type !== 'editorServiceResult' || typeof value.requestId !== 'string' || !value.requestId) return null;
  const result = decodeRequestResult<EditorServiceValue>(value.result, candidate => {
    if (!record(candidate)) return null;
    if (typeof candidate.text === 'string' && candidate.text.length <= 5_000_000) return { text: candidate.text };
    if (Array.isArray(candidate.candidates) && candidate.candidates.length <= 50 && candidate.candidates.every(item => record(item) && ['label', 'insert', 'detail'].every(key => typeof item[key] === 'string' && String(item[key]).length <= 1000) && (item.anchor === undefined || typeof item.anchor === 'string' && item.anchor.length <= 1000))) return { candidates: candidate.candidates as LinkCandidate[] };
    return null;
  });
  return result ? { type: value.type, requestId: value.requestId, result } : null;
}
