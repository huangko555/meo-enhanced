export type EditorStyleEnvironment = {
  readonly editorFontFamily?: string;
  readonly editorFontSizePx?: number;
  readonly editorFontWeight?: string;
  readonly editorBackgroundColor?: string;
  readonly editorForegroundColor?: string;
  readonly codeBlockBackgroundColor?: string;
  readonly sideBarBackgroundColor?: string;
  readonly panelBorderColor?: string;
  readonly liveFontFamily?: string;
  readonly sourceFontFamily?: string;
  readonly liveFontWeight?: string;
  readonly sourceFontWeight?: string;
  readonly liveLineHeight?: number;
  readonly sourceLineHeight?: number;
  readonly meoThemeColors?: Readonly<Record<string, string>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const stringKeys = [
  'editorFontFamily',
  'editorFontWeight',
  'editorBackgroundColor',
  'editorForegroundColor',
  'codeBlockBackgroundColor',
  'sideBarBackgroundColor',
  'panelBorderColor',
  'liveFontFamily',
  'sourceFontFamily',
  'liveFontWeight',
  'sourceFontWeight'
] as const;

const numberKeys = ['editorFontSizePx', 'liveLineHeight', 'sourceLineHeight'] as const;

export function decodeEditorStyleEnvironment(value: unknown): EditorStyleEnvironment | null {
  if (!isRecord(value)) return null;
  for (const key of stringKeys) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }
  for (const key of numberKeys) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null;
  }
  if (value.meoThemeColors !== undefined) {
    if (!isRecord(value.meoThemeColors)
      || Object.values(value.meoThemeColors).some((color) => typeof color !== 'string')) return null;
  }
  return value as EditorStyleEnvironment;
}
