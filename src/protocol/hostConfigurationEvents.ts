import { decodeUiColors, type UiColors } from '../foundation/uiColors';
import { normalizeEditorLineHeight } from '../foundation/editorLineHeight';

export type CodeThemeDto = {
  readonly name: string;
  readonly type: 'light' | 'dark';
  readonly colors: Record<string, string>;
  readonly tokenColors: unknown[];
  readonly sourceColors?: Record<string, string>;
  readonly sourceTokenColors?: unknown[];
};

export type HostConfigurationEvent =
  | { readonly type: 'editorMouseWheelZoomChanged'; readonly enabled: boolean }
  | { readonly type: 'editorLineHeightChanged'; readonly value: number }
  | { readonly type: 'uiColorsChanged'; readonly colors: UiColors }
  | { readonly type: 'toggleMode' }
  | { readonly type: 'developmentStylesChanged'; readonly css: string }
  | { readonly type: 'largeDocumentOptimizationChanged'; readonly enabled: boolean }
  | { readonly type: 'tableStickyHeaderChanged'; readonly enabled: boolean }
  | { readonly type: 'boldHeadingsChanged'; readonly enabled: boolean }
  | { readonly type: 'restoreReadingPositionOnOpenChanged'; readonly enabled: boolean }
  | {
      readonly type: 'vscodeCodeThemeChanged';
      readonly appearance: 'light' | 'dark';
      readonly vscodeTheme: CodeThemeDto | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function decodeCodeTheme(value: unknown): CodeThemeDto | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isRecord(value)
    && typeof value.name === 'string'
    && (value.type === 'light' || value.type === 'dark')
    && isRecord(value.colors)
    && Object.values(value.colors).every((color) => typeof color === 'string')
    && Array.isArray(value.tokenColors)
    && value.tokenColors.every(isJsonValue)
    && (value.sourceColors === undefined || isRecord(value.sourceColors) && Object.values(value.sourceColors).every(color => typeof color === 'string'))
    && (value.sourceTokenColors === undefined || Array.isArray(value.sourceTokenColors) && value.sourceTokenColors.every(isJsonValue))
    ? value as CodeThemeDto : false;
}

export function decodeHostConfigurationEvent(value: unknown): HostConfigurationEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'uiColorsChanged': {
      const colors = decodeUiColors(value.colors);
      return colors ? { type: value.type, colors } : null;
    }
    case 'toggleMode':
      return { type: 'toggleMode' };
    case 'editorLineHeightChanged':
      return typeof value.value === 'number' && Number.isFinite(value.value) && normalizeEditorLineHeight(value.value) === value.value ? value as HostConfigurationEvent : null;
    case 'developmentStylesChanged':
      return typeof value.css === 'string' ? { type: 'developmentStylesChanged', css: value.css } : null;
    case 'largeDocumentOptimizationChanged':
    case 'editorMouseWheelZoomChanged':
    case 'tableStickyHeaderChanged':
    case 'boldHeadingsChanged':
    case 'restoreReadingPositionOnOpenChanged':
      return typeof value.enabled === 'boolean' ? value as HostConfigurationEvent : null;
    case 'vscodeCodeThemeChanged':
      return (value.appearance === 'light' || value.appearance === 'dark')
        && decodeCodeTheme(value.vscodeTheme) !== false && decodeCodeTheme(value.vscodeTheme) !== undefined
        ? value as HostConfigurationEvent : null;
    default:
      return null;
  }
}
