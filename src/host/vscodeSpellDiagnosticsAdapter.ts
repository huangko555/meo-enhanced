import * as vscode from 'vscode';
import {
  getDefaultSettings,
  mergeSettings,
  searchForConfig,
  spellCheckDocument,
  type CSpellUserSettings,
  type ValidationIssue
} from 'cspell-lib';
import type { HostDiagnosticsRuntime } from '../application/hostDiagnosticsLifecycle';
import type { SerializedDiagnostic } from '../protocol/diagnostics';

const MEO_SPELL_DIAGNOSTIC_SOURCE = 'MEO Spell';

const maxSpellCheckTextLength = 1_000_000;
const maxSpellSuggestions = 1;

export type VscodeSpellDiagnosticsAdapter = HostDiagnosticsRuntime<vscode.Diagnostic> & {
  readCombined(): SerializedDiagnostic[];
  isInternalSource(source: string | undefined): boolean;
  collectSuggestions(from: number, to: number, enabled: boolean): Promise<string[]>;
};

/** Keeps VS Code Diagnostic and cspell details behind the Host diagnostics seam. */
export function createVscodeSpellDiagnosticsAdapter(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): VscodeSpellDiagnosticsAdapter {
  return {
    computeInternal: (enabled) => collectMeoSpellDiagnostics(document, enabled),
    hasExternal: () => hasExternalSpellDiagnostics(document),
    replaceInternal: (diagnostics) => collection.set(document.uri, [...diagnostics]),
    clearInternal: () => collection.delete(document.uri),
    readCombined: () => serializeDiagnostics(document),
    isInternalSource: (source) => source === MEO_SPELL_DIAGNOSTIC_SOURCE,
    collectSuggestions: (from, to, enabled) => collectMeoSpellSuggestions(document, from, to, enabled)
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

function shouldRunMeoSpellCheck(
  document: vscode.TextDocument,
  meoEnabledOverride?: boolean
): boolean {
  if (document.uri.scheme !== 'file') return false;
  if (document.getText().length > maxSpellCheckTextLength) return false;
  const meoEnabled = typeof meoEnabledOverride === 'boolean'
    ? meoEnabledOverride
    : vscode.workspace.getConfiguration('meoEnhanced', document.uri).get<boolean>('spellCheck.enabled', true);
  if (!meoEnabled) return false;
  return vscode.workspace.getConfiguration('cSpell', document.uri).get<boolean>('enabled', true);
}

function hasExternalSpellDiagnostics(document: vscode.TextDocument): boolean {
  return vscode.languages.getDiagnostics(document.uri).some((diagnostic) => {
    if (diagnostic.source === MEO_SPELL_DIAGNOSTIC_SOURCE) return false;
    const source = `${diagnostic.source ?? ''}`.toLowerCase();
    return source.includes('spell') || source.includes('cspell');
  });
}

async function collectMeoSpellDiagnostics(
  document: vscode.TextDocument,
  meoEnabledOverride?: boolean
): Promise<vscode.Diagnostic[]> {
  if (!shouldRunMeoSpellCheck(document, meoEnabledOverride) || hasExternalSpellDiagnostics(document)) return [];
  const text = document.getText().replace(/\r\n?/g, '\n');
  const settings = await resolveCSpellSettings(document);
  const result = await spellCheckDocument(
    { uri: document.uri.toString(), text, languageId: document.languageId || 'markdown' },
    { generateSuggestions: false },
    settings
  );
  if (!result.checked) return [];
  return result.issues.map((issue) => createDiagnostic(document, issue));
}

async function collectMeoSpellSuggestions(
  document: vscode.TextDocument,
  normalizedFrom: number,
  normalizedTo: number,
  meoEnabledOverride?: boolean
): Promise<string[]> {
  if (!shouldRunMeoSpellCheck(document, meoEnabledOverride)) return [];
  const text = document.getText().replace(/\r\n?/g, '\n');
  const settings = await resolveCSpellSettings(document);
  const result = await spellCheckDocument(
    { uri: document.uri.toString(), text, languageId: document.languageId || 'markdown' },
    { generateSuggestions: true },
    { ...settings, numSuggestions: maxSpellSuggestions, suggestionsTimeout: 750 }
  );
  if (!result.checked) return [];
  const targetFrom = Math.max(0, Math.floor(normalizedFrom));
  const targetTo = Math.max(targetFrom, Math.floor(normalizedTo));
  const issue = result.issues.find((candidate) => {
    const from = Math.max(0, Math.floor(candidate.offset));
    const to = from + Math.max(1, Math.floor(candidate.length ?? candidate.text.length));
    return from === targetFrom && to === targetTo;
  });
  return uniqueSuggestions(issue?.suggestions ?? [], issue?.text ?? '').slice(0, maxSpellSuggestions);
}

async function resolveCSpellSettings(document: vscode.TextDocument): Promise<CSpellUserSettings> {
  const localConfig = await searchForConfig(document.uri.fsPath);
  if (!localConfig) return getDefaultSettings();
  return mergeSettings(getDefaultSettings(), localConfig);
}

function uniqueSuggestions(suggestions: string[], original: string): string[] {
  const seen = new Set<string>();
  const normalizedOriginal = original.toLowerCase();
  const result: string[] = [];
  for (const suggestion of suggestions) {
    const trimmed = `${suggestion}`.trim();
    if (!trimmed || trimmed.toLowerCase() === normalizedOriginal || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function createDiagnostic(document: vscode.TextDocument, issue: ValidationIssue): vscode.Diagnostic {
  const offset = Number.isFinite(issue.offset) ? Math.max(0, Math.floor(issue.offset)) : 0;
  const length = Number.isFinite(issue.length) ? Math.max(1, Math.floor(issue.length ?? 1)) : 1;
  const documentText = document.getText();
  const start = document.positionAt(mapNormalizedOffsetToDocumentOffset(documentText, offset));
  const end = document.positionAt(mapNormalizedOffsetToDocumentOffset(documentText, offset + length));
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(start, end),
    issue.message || `Unknown word: ${issue.text}`,
    vscode.DiagnosticSeverity.Information
  );
  diagnostic.source = MEO_SPELL_DIAGNOSTIC_SOURCE;
  diagnostic.code = issue.text;
  return diagnostic;
}

function mapNormalizedOffsetToDocumentOffset(documentText: string, normalizedOffset: number): number {
  const target = Number.isFinite(normalizedOffset) ? Math.max(0, normalizedOffset) : documentText.length;
  if (target === 0) return 0;
  let normalizedIndex = 0;
  let documentIndex = 0;
  while (documentIndex < documentText.length && normalizedIndex < target) {
    if (documentText.charCodeAt(documentIndex) === 13) {
      documentIndex += documentText.charCodeAt(documentIndex + 1) === 10 ? 2 : 1;
      normalizedIndex += 1;
      continue;
    }
    documentIndex += 1;
    normalizedIndex += 1;
  }
  return documentIndex;
}
