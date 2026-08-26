import { decodeDiagnosticsChangedEvent, type SerializedDiagnostic } from './diagnostics';
import {
  decodeCodeTheme,
  type CodeThemeDto
} from './hostConfigurationEvents';
import { normalizePreviewFontFamily } from './editorStyleEnvironment';

export type EditorMode = 'live' | 'source' | 'preview';
export type PreviewAppearance = 'auto' | 'dark' | 'light';

export type ReadyMessage = {
  readonly type: 'ready';
};

export type SavedRevisionDto = {
  readonly version: number | null;
  readonly text: string;
};

export type InitMessage = {
  readonly type: 'init';
  readonly documentId: string;
  readonly text: string;
  readonly version: number;
  readonly savedRevision: SavedRevisionDto | null;
  readonly diagnostics: readonly SerializedDiagnostic[];
  readonly mode: EditorMode;
  readonly previewAppearance: PreviewAppearance;
  readonly previewFontFamily: string;
  readonly previewSourceColoring: boolean;
  readonly editorAppearance: PreviewAppearance;
  readonly gitChangesGutter: boolean;
  readonly gitDiffLineHighlights: boolean;
  readonly diffBaselineMode: 'current-edit' | 'recent-save' | 'git-head';
  readonly fixedBaselinePinned: boolean;
  readonly fixedBaselineActive: boolean;
  readonly contentMaxWidthEnabled: boolean;
  readonly findOptions: { readonly wholeWord: boolean; readonly caseSensitive: boolean };
  readonly outlinePosition: 'left' | 'right';
  readonly outlineVisible: boolean;
  readonly outlineWidth: number;
  readonly vscodeTheme: CodeThemeDto | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEditorMode(value: unknown): value is EditorMode {
  return value === 'live' || value === 'source' || value === 'preview';
}

function isPreviewAppearance(value: unknown): value is PreviewAppearance {
  return value === 'auto' || value === 'dark' || value === 'light';
}

export function decodeReadyMessage(value: unknown): ReadyMessage | null {
  return isRecord(value) && value.type === 'ready' ? { type: 'ready' } : null;
}

export function decodeInitMessage(value: unknown): InitMessage | null {
  const previewFontFamily = isRecord(value) && typeof value.previewFontFamily === 'string'
    ? normalizePreviewFontFamily(value.previewFontFamily)
    : null;
  if (!isRecord(value)
    || value.type !== 'init'
    || 'theme' in value
    || 'shikiCodeBlocks' in value
    || 'codeTheme' in value
    || 'lineNumbers' in value
    || 'restoreTopLine' in value
    || 'restoreTopLineOffset' in value
    || 'previewFontFamilyName' in value
    || 'previewFontFamilyFallback' in value
    || 'previewFontFamilies' in value
    || typeof value.documentId !== 'string'
    || value.documentId.length === 0
    || typeof value.text !== 'string'
    || typeof value.version !== 'number'
    || !Number.isInteger(value.version)
    || value.version < 0
    || !isSavedRevision(value.savedRevision, value.version, value.text)
    || !isEditorMode(value.mode)
    || !isPreviewAppearance(value.previewAppearance)
    || previewFontFamily === null
    || typeof value.previewSourceColoring !== 'boolean'
    || !isPreviewAppearance(value.editorAppearance)
    || !Array.isArray(value.diagnostics)
    || decodeDiagnosticsChangedEvent({ type: 'diagnosticsChanged', diagnostics: value.diagnostics }) === null
    || typeof value.gitChangesGutter !== 'boolean'
    || typeof value.gitDiffLineHighlights !== 'boolean'
    || (value.diffBaselineMode !== 'current-edit'
      && value.diffBaselineMode !== 'recent-save'
      && value.diffBaselineMode !== 'git-head')
    || typeof value.fixedBaselinePinned !== 'boolean'
    || typeof value.fixedBaselineActive !== 'boolean'
    || typeof value.contentMaxWidthEnabled !== 'boolean'
    || !isRecord(value.findOptions)
    || typeof value.findOptions.wholeWord !== 'boolean'
    || typeof value.findOptions.caseSensitive !== 'boolean'
    || (value.outlinePosition !== 'left' && value.outlinePosition !== 'right')
    || typeof value.outlineVisible !== 'boolean'
    || typeof value.outlineWidth !== 'number'
    || !Number.isFinite(value.outlineWidth)
    || value.outlineWidth <= 0
    || decodeCodeTheme(value.vscodeTheme) === false
    || decodeCodeTheme(value.vscodeTheme) === undefined) {
    return null;
  }
  return { ...value, previewFontFamily } as InitMessage;
}

function isSavedRevision(value: unknown, currentVersion: number, currentText: string): value is SavedRevisionDto | null {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.text !== 'string') return false;
  if (value.version === null) return true;
  return typeof value.version === 'number'
    && Number.isInteger(value.version)
    && value.version >= 0
    && value.version <= currentVersion
    && (value.version !== currentVersion || value.text === currentText);
}
