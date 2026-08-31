export const EDITOR_FONT_SIZE_MIN = 10;
export const EDITOR_FONT_SIZE_MAX = 32;
export const DEFAULT_EDITOR_FONT_SIZE = 14;

export type EditorFontSizeMode = 'auto' | 'custom';

export type EditorFontSizePreference = Readonly<{
  mode: EditorFontSizeMode;
  value: number;
}>;

export function normalizeEditorFontSizeMode(value: unknown): EditorFontSizeMode {
  return value === 'custom' ? 'custom' : 'auto';
}

export function normalizeEditorFontSize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_EDITOR_FONT_SIZE;
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(numeric)));
}

export function normalizeEditorFontSizePreference(value: {
  readonly mode?: unknown;
  readonly value?: unknown;
}): EditorFontSizePreference {
  return Object.freeze({
    mode: normalizeEditorFontSizeMode(value.mode),
    value: normalizeEditorFontSize(value.value)
  });
}
