import { normalizePreviewFontFamily } from './editorStyleEnvironment';
import { isUiLanguagePreference, type UiLanguagePreference } from '../foundation/uiLanguage';
import type { SourceLineNumberMode } from './readyInit';
import {
  normalizeEditorFontSize,
  type EditorFontSizeMode
} from '../foundation/editorFontSize';

export type EditorMode = 'live' | 'source' | 'preview';
export type EditorAppearance = 'auto' | 'dark' | 'light';
export type DiffBaselineMode = 'current-edit' | 'recent-save' | 'git-head';
export type OutlinePosition = 'left' | 'right';

export type EditorCommand =
  | { readonly type: 'setMode'; readonly mode: EditorMode }
  | { readonly type: 'setGitChangesGutter'; readonly visible?: boolean; readonly enabled?: boolean }
  | { readonly type: 'setGitDiffDetailsVisible'; readonly visible: boolean }
  | { readonly type: 'setDiffBaselineMode'; readonly mode: DiffBaselineMode }
  | { readonly type: 'setFixedBaseline'; readonly enabled: boolean }
  | { readonly type: 'updateFixedBaseline' }
  | { readonly type: 'releaseFixedBaseline' }
  | { readonly type: 'setOutlineVisible'; readonly visible: boolean }
  | { readonly type: 'setOutlinePosition'; readonly position: OutlinePosition }
  | { readonly type: 'setOutlineWidth'; readonly width: number }
  | { readonly type: 'setContentMaxWidth'; readonly enabled: boolean }
  | {
      readonly type: 'setFindOptions';
      readonly wholeWord?: boolean;
      readonly caseSensitive?: boolean;
      readonly findOptions?: { readonly wholeWord?: boolean; readonly caseSensitive?: boolean };
    }
  | { readonly type: 'openLink'; readonly href: string; readonly source?: 'preview' }
  | { readonly type: 'openImageExternally'; readonly url: string }
  | { readonly type: 'reloadDocumentFromDisk'; readonly topLine: number; readonly topLineOffset?: number }
  | { readonly type: 'exportDocument'; readonly format: 'html' | 'pdf' }
  | { readonly type: 'setPreviewAppearance'; readonly appearance: EditorAppearance }
  | { readonly type: 'setPreviewFontFamily'; readonly fontFamily: string }
  | { readonly type: 'setPreviewSourceColoring'; readonly enabled: boolean }
  | { readonly type: 'setEditorAppearance'; readonly appearance: EditorAppearance }
  | { readonly type: 'setEditorFontSize'; readonly mode: EditorFontSizeMode; readonly value: number }
  | { readonly type: 'setUiLanguagePreference'; readonly language: UiLanguagePreference }
  | { readonly type: 'setSourceLineNumbers'; readonly mode: SourceLineNumberMode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function decodeEditorCommand(value: unknown): EditorCommand | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'setMode':
      return value.mode === 'live' || value.mode === 'source' || value.mode === 'preview' ? value as EditorCommand : null;
    case 'setGitChangesGutter':
      return (value.visible === undefined || isBoolean(value.visible))
        && (value.enabled === undefined || isBoolean(value.enabled))
        && (isBoolean(value.visible) || isBoolean(value.enabled)) ? value as EditorCommand : null;
    case 'setGitDiffDetailsVisible':
      return isBoolean(value.visible) ? value as EditorCommand : null;
    case 'setFixedBaseline':
    case 'setContentMaxWidth':
      return isBoolean(value.enabled) ? value as EditorCommand : null;
    case 'setDiffBaselineMode':
      return value.mode === 'current-edit' || value.mode === 'recent-save' || value.mode === 'git-head'
        ? value as EditorCommand : null;
    case 'updateFixedBaseline':
    case 'releaseFixedBaseline':
      return { type: value.type } as EditorCommand;
    case 'setOutlineVisible':
      return isBoolean(value.visible) ? value as EditorCommand : null;
    case 'setOutlinePosition':
      return value.position === 'left' || value.position === 'right' ? value as EditorCommand : null;
    case 'setOutlineWidth':
      return isFiniteNumber(value.width) && value.width > 0 ? value as EditorCommand : null;
    case 'setFindOptions': {
      const nested = value.findOptions;
      if (nested !== undefined && (!isRecord(nested)
        || (nested.wholeWord !== undefined && !isBoolean(nested.wholeWord))
        || (nested.caseSensitive !== undefined && !isBoolean(nested.caseSensitive)))) return null;
      return (value.wholeWord === undefined || isBoolean(value.wholeWord))
        && (value.caseSensitive === undefined || isBoolean(value.caseSensitive)) ? value as EditorCommand : null;
    }
    case 'reloadDocumentFromDisk':
      return isPositiveInteger(value.topLine)
        && (value.topLineOffset === undefined || isFiniteNumber(value.topLineOffset)) ? value as EditorCommand : null;
    case 'openLink':
      return typeof value.href === 'string' && value.href.length > 0
        && (value.source === undefined || value.source === 'preview') ? value as EditorCommand : null;
    case 'openImageExternally':
      return typeof value.url === 'string' && value.url.length > 0 ? value as EditorCommand : null;
    case 'exportDocument':
      return (value.format === 'html' || value.format === 'pdf') && value.appearance === undefined
        ? value as EditorCommand
        : null;
    case 'setPreviewAppearance':
    case 'setEditorAppearance':
      return value.appearance === 'auto' || value.appearance === 'dark' || value.appearance === 'light'
        ? value as EditorCommand : null;
    case 'setEditorFontSize':
      return (value.mode === 'auto' || value.mode === 'custom')
        && isFiniteNumber(value.value)
        && normalizeEditorFontSize(value.value) === value.value
        ? value as EditorCommand
        : null;
    case 'setPreviewSourceColoring':
      return typeof value.enabled === 'boolean' ? value as EditorCommand : null;
    case 'setPreviewFontFamily': {
      if (typeof value.fontFamily !== 'string') return null;
      const fontFamily = normalizePreviewFontFamily(value.fontFamily);
      return fontFamily === null ? null : { type: value.type, fontFamily };
    }
    case 'setUiLanguagePreference':
      return isUiLanguagePreference(value.language) ? value as EditorCommand : null;
    case 'setSourceLineNumbers':
      return value.mode === 'on' || value.mode === 'off' || value.mode === 'relative' || value.mode === 'interval'
        ? value as EditorCommand
        : null;
    default:
      return null;
  }
}
