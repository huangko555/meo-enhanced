import type { PreviewDocumentOperation, PreviewDocumentResult, PreviewDocumentPosition,
  PreviewDocumentChunk, PreviewDocumentManifest } from '../foundation/previewDocument';
import { decodeRequestResult, type RequestResult } from './requestResult';

export type PreviewDocumentRequest = Readonly<{ type: 'requestPreviewDocument'; requestId: string;
  documentId: string; operation: PreviewDocumentOperation }>;
export type PreviewDocumentResponse = Readonly<{ type: 'previewDocumentResult'; requestId: string;
  documentId: string; result: RequestResult<PreviewDocumentResult> }>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const position = (value: unknown): value is PreviewDocumentPosition => record(value) && integer(value.block) && integer(value.offset);
const chunk = (value: unknown): value is PreviewDocumentChunk => record(value) && integer(value.index)
  && typeof value.html === 'string' && typeof value.hasMermaid === 'boolean';

export function decodePreviewDocumentManifest(value: unknown): PreviewDocumentManifest | null {
  if (!record(value) || !id(value.id) || !integer(value.anchorLine) || value.anchorLine < 1
    || !Array.isArray(value.blocks) || !Array.isArray(value.chunks)
    || !value.chunks.every(chunk) || !Array.isArray(value.headings)) return null;
  const blockCount = value.blocks.length;
  if (!value.blocks.every((block, index) => record(block) && block.index === index && integer(block.sourceLine)
    && block.sourceLine >= 1 && integer(block.sourceEndLine) && block.sourceEndLine >= block.sourceLine
    && integer(block.sourceCharacters) && typeof block.kind === 'string'
    && (block.sourceRanges === undefined || Array.isArray(block.sourceRanges) && block.sourceRanges.every(range =>
      record(range) && integer(range.start) && range.start >= 1 && integer(range.end) && range.end >= range.start)))
    || !value.headings.every(heading => record(heading) && typeof heading.text === 'string' && typeof heading.id === 'string'
      && integer(heading.line) && integer(heading.level) && heading.level >= 1 && heading.level <= 6)
    || value.chunks.some(block => block.index >= blockCount)) return null;
  return value as unknown as PreviewDocumentManifest;
}

export function decodePreviewDocumentRequest(value: unknown): PreviewDocumentRequest | null {
  if (!record(value) || value.type !== 'requestPreviewDocument' || !id(value.requestId) || !id(value.documentId)
    || !record(value.operation)) return null;
  const op = value.operation;
  let operation: PreviewDocumentOperation;
  if (op.kind === 'blocks' && Array.isArray(op.indices) && op.indices.length <= 128 && op.indices.every(integer)) {
    operation = { kind: 'blocks', indices: op.indices };
  } else if (op.kind === 'locate' && ((integer(op.sourceLine) && op.sourceLine >= 1) || typeof op.anchor === 'string')) {
    operation = { kind: 'locate', ...(typeof op.anchor === 'string' ? { anchor: op.anchor } : { sourceLine: op.sourceLine as number }) };
  } else if (op.kind === 'search' && typeof op.query === 'string' && typeof op.caseSensitive === 'boolean'
    && typeof op.wholeWord === 'boolean' && (op.selectIndex === undefined || integer(op.selectIndex))
    && (op.anchor === undefined || record(op.anchor) && integer(op.anchor.line) && integer(op.anchor.occurrence))) {
    operation = { kind: 'search', query: op.query, caseSensitive: op.caseSensitive, wholeWord: op.wholeWord,
      ...(op.selectIndex === undefined ? {} : { selectIndex: op.selectIndex as number }) };
    if (record(op.anchor)) operation = { ...operation, anchor: { line: op.anchor.line as number, occurrence: op.anchor.occurrence as number } };
  } else if (op.kind === 'copy' && position(op.from) && position(op.to)) operation = { kind: 'copy', from: op.from, to: op.to };
  else return null;
  return { type: 'requestPreviewDocument', requestId: value.requestId, documentId: value.documentId, operation };
}

export function decodePreviewDocumentResponse(value: unknown): PreviewDocumentResponse | null {
  if (!record(value) || value.type !== 'previewDocumentResult' || !id(value.requestId) || !id(value.documentId)) return null;
  const result = decodeRequestResult(value.result, (candidate): PreviewDocumentResult | null => {
    if (!record(candidate)) return null;
    if (candidate.kind === 'blocks' && Array.isArray(candidate.chunks) && candidate.chunks.every(chunk)) {
      return { kind: 'blocks', chunks: candidate.chunks };
    }
    if (candidate.kind === 'locate' && (candidate.block === null || integer(candidate.block))) {
      return { kind: 'locate', block: candidate.block };
    }
    if (candidate.kind === 'copy' && typeof candidate.text === 'string' && typeof candidate.html === 'string') {
      return { kind: 'copy', text: candidate.text, html: candidate.html };
    }
    if (candidate.kind === 'search' && integer(candidate.total) && Array.isArray(candidate.blocks)
      && candidate.blocks.every(entry => Array.isArray(entry) && entry.length === 2 && entry.every(integer))
      && (candidate.active === null || record(candidate.active) && integer(candidate.active.block) && integer(candidate.active.offset)
        && integer(candidate.active.end) && integer(candidate.active.line) && integer(candidate.active.occurrence) && integer(candidate.active.index))) {
      return candidate as unknown as Extract<PreviewDocumentResult, { kind: 'search' }>;
    }
    return null;
  });
  return result === null ? null : { type: 'previewDocumentResult', requestId: value.requestId, documentId: value.documentId, result };
}
