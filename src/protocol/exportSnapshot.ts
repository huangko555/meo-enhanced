import { decodeEditorStyleEnvironment, type EditorStyleEnvironment } from './editorStyleEnvironment';
import { decodeRequestResult, type RequestResult } from './requestResult';

export const EXPORT_SNAPSHOT_TIMEOUT_MS = 20_000;

export type ExportSnapshotRequest = {
  readonly type: 'requestExportSnapshot';
  readonly requestId: string;
};

export type ExportSnapshotValue = {
  readonly text: string;
  readonly environment?: EditorStyleEnvironment;
};

export type ExportSnapshotResolution = RequestResult<ExportSnapshotValue>;

export type ExportSnapshotResponse = {
  readonly type: 'exportSnapshotResult';
  readonly requestId: string;
  readonly result: ExportSnapshotResolution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function decodeExportSnapshotRequest(value: unknown): ExportSnapshotRequest | null {
  if (!isRecord(value) || value.type !== 'requestExportSnapshot' || !isNonEmptyString(value.requestId)) return null;
  return { type: 'requestExportSnapshot', requestId: value.requestId };
}

export function decodeExportSnapshotResponse(value: unknown): ExportSnapshotResponse | null {
  const result = isRecord(value)
    ? decodeRequestResult(value.result, (candidate): ExportSnapshotValue | null => {
        if (!isRecord(candidate) || typeof candidate.text !== 'string') return null;
        const environment = candidate.environment === undefined
          ? undefined
          : decodeEditorStyleEnvironment(candidate.environment);
        if (candidate.environment !== undefined && environment === null) return null;
        return environment ? { text: candidate.text, environment } : { text: candidate.text };
      })
    : null;
  if (!isRecord(value)
    || value.type !== 'exportSnapshotResult'
    || !isNonEmptyString(value.requestId)
    || result === null) return null;
  return { type: 'exportSnapshotResult', requestId: value.requestId, result };
}
