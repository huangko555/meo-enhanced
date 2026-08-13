export type EditorAppearance = 'auto' | 'dark' | 'light';
export type ResolvedEditorAppearance = Exclude<EditorAppearance, 'auto'>;

export const EDITOR_APPEARANCE_STATE_KEY = 'editorAppearance';

export function normalizeEditorAppearance(value: unknown): EditorAppearance {
  return value === 'light' || value === 'dark' ? value : 'auto';
}
