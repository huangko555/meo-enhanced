import * as vscode from 'vscode';
import type { SerializedDiagnostic } from '../protocol/diagnostics';

export type VscodeDiagnosticsAdapter = {
  read(): SerializedDiagnostic[];
};

/** Serializes diagnostics already owned by VS Code without creating MEO diagnostics. */
export function createVscodeDiagnosticsAdapter(document: vscode.TextDocument): VscodeDiagnosticsAdapter {
  return {
    read: () => serializeDiagnostics(document)
  };
}

function mapDocumentOffsetToNormalizedOffset(documentText: string, documentOffset: number): number {
  const target = Math.max(0, Math.min(documentOffset, documentText.length));
  let normalizedIndex = 0;
  let documentIndex = 0;

  while (documentIndex < target) {
    if (documentText.charCodeAt(documentIndex) === 13) {
      if (documentText.charCodeAt(documentIndex + 1) === 10 && documentIndex + 1 < target) {
        documentIndex += 2;
      } else {
        documentIndex += 1;
      }
      normalizedIndex += 1;
      continue;
    }

    documentIndex += 1;
    normalizedIndex += 1;
  }

  return normalizedIndex;
}

function normalizeDiagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  if (code && typeof code === 'object' && 'value' in code) return String(code.value);
  return undefined;
}

function clampDiagnosticRange(from: number, to: number, textLength: number): { from: number; to: number } | null {
  const clampedFrom = Math.max(0, Math.min(Math.floor(from), textLength));
  let clampedTo = Math.max(0, Math.min(Math.floor(to), textLength));
  if (clampedTo < clampedFrom) clampedTo = clampedFrom;
  if (clampedTo === clampedFrom && clampedFrom < textLength) clampedTo = clampedFrom + 1;
  if (clampedTo === clampedFrom && clampedFrom > 0) return { from: clampedFrom - 1, to: clampedFrom };
  if (clampedTo === clampedFrom) return null;
  return { from: clampedFrom, to: clampedTo };
}

function serializeDiagnostics(document: vscode.TextDocument): SerializedDiagnostic[] {
  const diagnostics = vscode.languages.getDiagnostics(document.uri);
  if (!diagnostics.length) return [];

  const documentText = document.getText();
  const normalizedTextLength = documentText.replace(/\r\n?/g, '\n').length;
  const serialized: SerializedDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const from = mapDocumentOffsetToNormalizedOffset(documentText, document.offsetAt(diagnostic.range.start));
    const to = mapDocumentOffsetToNormalizedOffset(documentText, document.offsetAt(diagnostic.range.end));
    const range = clampDiagnosticRange(from, to, normalizedTextLength);
    if (!range) continue;
    const severity = diagnostic.severity;
    serialized.push({
      from: range.from,
      to: range.to,
      severity: severity === 0 || severity === 1 || severity === 2 || severity === 3 ? severity : 0,
      message: diagnostic.message,
      source: diagnostic.source,
      code: normalizeDiagnosticCode(diagnostic.code)
    });
  }
  return serialized;
}
