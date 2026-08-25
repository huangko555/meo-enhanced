import { decodeEditorStyleEnvironment, type EditorStyleEnvironment } from './editorStyleEnvironment';
import type { PreviewAppearance } from './previewRender';
import { decodeRequestResult, type RequestResult } from './requestResult';

export const EXPORT_SNAPSHOT_TIMEOUT_MS = 20_000;

export type ExportSnapshotRequest = {
  readonly type: 'requestExportSnapshot';
  readonly requestId: string;
};

export type ReadingSnapshot = {
  readonly snapshotId: string;
  readonly text: string;
  readonly appearance: PreviewAppearance;
  readonly environment: EditorStyleEnvironment;
};

export type ExportSnapshotValue = ReadingSnapshot;

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
        if (!isRecord(candidate)
          || !isNonEmptyString(candidate.snapshotId)
          || typeof candidate.text !== 'string'
          || (candidate.appearance !== 'dark' && candidate.appearance !== 'light')) return null;
        const environment = decodeEditorStyleEnvironment(candidate.environment);
        if (environment === null) return null;
        return {
          snapshotId: candidate.snapshotId,
          text: candidate.text,
          appearance: candidate.appearance,
          environment
        };
      })
    : null;
  if (!isRecord(value)
    || value.type !== 'exportSnapshotResult'
    || !isNonEmptyString(value.requestId)
    || result === null
    || (result.ok && result.value.snapshotId !== value.requestId)) return null;
  return { type: 'exportSnapshotResult', requestId: value.requestId, result };
}
