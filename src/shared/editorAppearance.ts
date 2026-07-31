export type EditorAppearance = 'dark' | 'light';

export const EDITOR_APPEARANCE_STATE_KEY = 'editorAppearance';

export function normalizeEditorAppearance(value: unknown): EditorAppearance {
  return value === 'light' ? 'light' : 'dark';
}
