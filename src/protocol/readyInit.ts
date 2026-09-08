import { decodeDiagnosticsChangedEvent, type SerializedDiagnostic } from './diagnostics';
import {
  decodeCodeTheme,
  type CodeThemeDto
} from './hostConfigurationEvents';
import { normalizePreviewFontFamily } from './editorStyleEnvironment';
import {
  isUiLanguage,
  isUiLanguagePreference,
  type UiLanguage,
  type UiLanguagePreference
} from '../foundation/uiLanguage';
import {
  DEFAULT_EDITOR_FONT_SIZE,
  normalizeEditorFontSize,
  type EditorFontSizeMode
} from '../foundation/editorFontSize';

export type EditorMode = 'live' | 'source' | 'preview';
export type PreviewAppearance = 'auto' | 'dark' | 'light';
export type SourceLineNumberMode = 'on' | 'off' | 'relative' | 'interval';

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
  readonly uiLanguage: UiLanguage;
  readonly uiLanguagePreference: UiLanguagePreference;
  readonly automaticUiLanguage: UiLanguage;
  readonly sourceLineNumbers: SourceLineNumberMode;
  readonly previewAppearance: PreviewAppearance;
  readonly previewFontFamily: string;
  readonly previewSourceColoring: boolean;
  readonly editorAppearance: PreviewAppearance;
  readonly editorFontSizeMode: EditorFontSizeMode;
  readonly editorFontSize: number;
  readonly gitChangesGutter: boolean;
  readonly gitDiffLineHighlights: boolean;
  readonly gitDiffDetailsVisible: boolean;
  readonly diffBaselineMode: 'current-edit' | 'recent-save' | 'git-head';
  readonly fixedBaselinePinned: boolean;
  readonly fixedBaselineActive: boolean;
  readonly fixedBaselineUpdatedAt?: number | null;
  readonly contentMaxWidthEnabled: boolean;
  readonly tableStickyHeaderEnabled: boolean;
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
  const editorFontSizeMode = isRecord(value) && value.editorFontSizeMode === undefined
    ? 'auto'
    : isRecord(value) && (value.editorFontSizeMode === 'auto' || value.editorFontSizeMode === 'custom')
      ? value.editorFontSizeMode
      : null;
  const editorFontSize = isRecord(value) && value.editorFontSize === undefined
    ? DEFAULT_EDITOR_FONT_SIZE
    : isRecord(value) && typeof value.editorFontSize === 'number'
      && normalizeEditorFontSize(value.editorFontSize) === value.editorFontSize
      ? value.editorFontSize
      : null;
  const tableStickyHeaderEnabled = isRecord(value) && value.tableStickyHeaderEnabled === undefined
    ? true
    : isRecord(value) && typeof value.tableStickyHeaderEnabled === 'boolean'
      ? value.tableStickyHeaderEnabled
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
    || !isUiLanguage(value.uiLanguage)
    || (value.uiLanguagePreference !== undefined && !isUiLanguagePreference(value.uiLanguagePreference))
    || (value.automaticUiLanguage !== undefined && !isUiLanguage(value.automaticUiLanguage))
    || !isSourceLineNumberMode(value.sourceLineNumbers)
    || !isPreviewAppearance(value.previewAppearance)
    || previewFontFamily === null
    || typeof value.previewSourceColoring !== 'boolean'
    || !isPreviewAppearance(value.editorAppearance)
    || editorFontSizeMode === null
    || editorFontSize === null
    || !Array.isArray(value.diagnostics)
    || decodeDiagnosticsChangedEvent({ type: 'diagnosticsChanged', diagnostics: value.diagnostics }) === null
    || typeof value.gitChangesGutter !== 'boolean'
    || typeof value.gitDiffLineHighlights !== 'boolean'
    || typeof value.gitDiffDetailsVisible !== 'boolean'
    || (value.diffBaselineMode !== 'current-edit'
      && value.diffBaselineMode !== 'recent-save'
      && value.diffBaselineMode !== 'git-head')
    || typeof value.fixedBaselinePinned !== 'boolean'
    || typeof value.fixedBaselineActive !== 'boolean'
    || (value.fixedBaselineUpdatedAt !== undefined
      && value.fixedBaselineUpdatedAt !== null
      && (typeof value.fixedBaselineUpdatedAt !== 'number' || !Number.isFinite(value.fixedBaselineUpdatedAt)))
    || typeof value.contentMaxWidthEnabled !== 'boolean'
    || tableStickyHeaderEnabled === null
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
  return {
    ...value,
    uiLanguagePreference: value.uiLanguagePreference ?? 'auto',
    automaticUiLanguage: value.automaticUiLanguage ?? value.uiLanguage,
    previewFontFamily,
    editorFontSizeMode,
    editorFontSize,
    tableStickyHeaderEnabled
  } as InitMessage;
}

function isSourceLineNumberMode(value: unknown): value is SourceLineNumberMode {
  return value === 'on' || value === 'off' || value === 'relative' || value === 'interval';
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
