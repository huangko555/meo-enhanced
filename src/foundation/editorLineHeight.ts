export const DEFAULT_EDITOR_LINE_HEIGHT = 1.5;
export const EDITOR_LINE_HEIGHT_MIN = 1;
export const EDITOR_LINE_HEIGHT_MAX = 2.5;

/** A font-size multiplier, rounded to the same tenth used by the settings control. */
export function normalizeEditorLineHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EDITOR_LINE_HEIGHT;
  return Math.round(Math.min(EDITOR_LINE_HEIGHT_MAX, Math.max(EDITOR_LINE_HEIGHT_MIN, value)) * 10) / 10;
}
