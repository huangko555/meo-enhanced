import { decodeDiagnosticsChangedEvent, type SerializedDiagnostic } from './diagnostics';
import {
  decodeCodeTheme,
  decodeThemeSettings,
  type CodeThemeDto,
  type ThemeSettingsDto,
  type VimKeybindingDto
} from './hostConfigurationEvents';

export type EditorMode = 'live' | 'source' | 'preview';
export type PreviewAppearance = 'dark' | 'light';

export type ReadyMessage = {
  readonly type: 'ready';
};

export type InitMessage = {
  readonly type: 'init';
  readonly text: string;
  readonly version: number;
  readonly diagnostics: readonly SerializedDiagnostic[];
  readonly mode: EditorMode;
  readonly previewAppearance: PreviewAppearance;
  readonly editorAppearance: PreviewAppearance;
  readonly lineNumbers: boolean;
  readonly gitChangesGutter: boolean;
  readonly gitBlameEnabled: boolean;
  readonly gitDiffLineHighlights: boolean;
  readonly diffBaselineMode: 'current-edit' | 'recent-save' | 'git-head';
  readonly fixedBaselinePinned: boolean;
  readonly fixedBaselineActive: boolean;
  readonly spellCheckEnabled: boolean;
  readonly contentMaxWidthEnabled: boolean;
  readonly longCodeBlockFoldingEnabled: boolean;
  readonly vimMode: boolean;
  readonly vimKeybindings: readonly VimKeybindingDto[];
  readonly vimLeader: string;
  readonly findOptions: { readonly wholeWord: boolean; readonly caseSensitive: boolean };
  readonly outlinePosition: 'left' | 'right';
  readonly outlineVisible: boolean;
  readonly outlineWidth: number;
  readonly theme: ThemeSettingsDto;
  readonly shikiCodeBlocks: boolean;
  readonly codeTheme: CodeThemeDto | null;
  readonly restoreTopLine?: number;
  readonly restoreTopLineOffset?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEditorMode(value: unknown): value is EditorMode {
  return value === 'live' || value === 'source' || value === 'preview';
}

function isPreviewAppearance(value: unknown): value is PreviewAppearance {
  return value === 'dark' || value === 'light';
}

function isVimKeybinding(value: unknown): value is VimKeybindingDto {
  return isRecord(value)
    && typeof value.before === 'string'
    && typeof value.after === 'string'
    && (value.mode === 'normal' || value.mode === 'insert' || value.mode === 'visual')
    && typeof value.recursive === 'boolean';
}

export function decodeReadyMessage(value: unknown): ReadyMessage | null {
  return isRecord(value) && value.type === 'ready' ? { type: 'ready' } : null;
}

export function decodeInitMessage(value: unknown): InitMessage | null {
  if (!isRecord(value)
    || value.type !== 'init'
    || typeof value.text !== 'string'
    || typeof value.version !== 'number'
    || !Number.isInteger(value.version)
    || value.version < 0
    || !isEditorMode(value.mode)
    || !isPreviewAppearance(value.previewAppearance)
    || !isPreviewAppearance(value.editorAppearance)
    || !Array.isArray(value.diagnostics)
    || decodeDiagnosticsChangedEvent({ type: 'diagnosticsChanged', diagnostics: value.diagnostics }) === null
    || typeof value.lineNumbers !== 'boolean'
    || typeof value.gitChangesGutter !== 'boolean'
    || typeof value.gitBlameEnabled !== 'boolean'
    || typeof value.gitDiffLineHighlights !== 'boolean'
    || (value.diffBaselineMode !== 'current-edit'
      && value.diffBaselineMode !== 'recent-save'
      && value.diffBaselineMode !== 'git-head')
    || typeof value.fixedBaselinePinned !== 'boolean'
    || typeof value.fixedBaselineActive !== 'boolean'
    || typeof value.spellCheckEnabled !== 'boolean'
    || typeof value.contentMaxWidthEnabled !== 'boolean'
    || typeof value.longCodeBlockFoldingEnabled !== 'boolean'
    || typeof value.vimMode !== 'boolean'
    || !Array.isArray(value.vimKeybindings)
    || value.vimKeybindings.some((binding) => !isVimKeybinding(binding))
    || typeof value.vimLeader !== 'string'
    || !isRecord(value.findOptions)
    || typeof value.findOptions.wholeWord !== 'boolean'
    || typeof value.findOptions.caseSensitive !== 'boolean'
    || (value.outlinePosition !== 'left' && value.outlinePosition !== 'right')
    || typeof value.outlineVisible !== 'boolean'
    || typeof value.outlineWidth !== 'number'
    || !Number.isFinite(value.outlineWidth)
    || value.outlineWidth <= 0
    || decodeThemeSettings(value.theme) === null
    || typeof value.shikiCodeBlocks !== 'boolean'
    || decodeCodeTheme(value.codeTheme) === false
    || decodeCodeTheme(value.codeTheme) === undefined
    || (value.restoreTopLine !== undefined
      && (typeof value.restoreTopLine !== 'number' || !Number.isInteger(value.restoreTopLine) || value.restoreTopLine < 1))
    || (value.restoreTopLineOffset !== undefined
      && (typeof value.restoreTopLineOffset !== 'number' || !Number.isFinite(value.restoreTopLineOffset)))) {
    return null;
  }
  return value as InitMessage;
}
