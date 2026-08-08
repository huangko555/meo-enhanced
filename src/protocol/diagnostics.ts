export type SerializedDiagnostic = {
  readonly from: number;
  readonly to: number;
  readonly severity: 0 | 1 | 2 | 3;
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
};

export type DiagnosticsChangedEvent = {
  readonly type: 'diagnosticsChanged';
  readonly diagnostics: readonly SerializedDiagnostic[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function decodeDiagnosticsChangedEvent(value: unknown): DiagnosticsChangedEvent | null {
  if (!isRecord(value) || value.type !== 'diagnosticsChanged' || !Array.isArray(value.diagnostics)) return null;
  for (const diagnostic of value.diagnostics) {
    if (!isRecord(diagnostic)
      || typeof diagnostic.from !== 'number' || !Number.isInteger(diagnostic.from) || diagnostic.from < 0
      || typeof diagnostic.to !== 'number' || !Number.isInteger(diagnostic.to) || diagnostic.to < diagnostic.from
      || (diagnostic.severity !== 0 && diagnostic.severity !== 1 && diagnostic.severity !== 2 && diagnostic.severity !== 3)
      || typeof diagnostic.message !== 'string'
      || (diagnostic.source !== undefined && typeof diagnostic.source !== 'string')
      || (diagnostic.code !== undefined && typeof diagnostic.code !== 'string')) return null;
  }
  return value as DiagnosticsChangedEvent;
}
