export type EditorStyleEnvironment = {
  readonly previewFontFamily?: string;
  readonly editorFontFamily?: string;
  readonly editorFontSizePx?: number;
  readonly editorFontWeight?: string;
  readonly editorBackgroundColor?: string;
  readonly editorForegroundColor?: string;
  readonly codeBlockBackgroundColor?: string;
  readonly sideBarBackgroundColor?: string;
  readonly panelBorderColor?: string;
  readonly liveFontWeight?: string;
  readonly sourceFontWeight?: string;
  readonly liveLineHeight?: number;
  readonly sourceLineHeight?: number;
  readonly meoThemeColors?: Readonly<Record<string, string>>;
  readonly previewSourceColoring?: boolean;
  readonly previewCodePalettes?: Readonly<Record<'light' | 'dark', Readonly<{
    foreground: string;
    comment: string;
    keyword: string;
    string: string;
    number: string;
    type: string;
    property: string;
    link: string;
  }>>>;
};

export const MAX_PREVIEW_FONT_FAMILY_LENGTH = 128;

export function normalizePreviewFontFamily(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length > MAX_PREVIEW_FONT_FAMILY_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
    || /[,"\\;{}]/u.test(normalized)) return null;
  return normalized;
}

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
  'liveFontWeight',
  'sourceFontWeight'
] as const;

const numberKeys = ['editorFontSizePx', 'liveLineHeight', 'sourceLineHeight'] as const;

export function decodeEditorStyleEnvironment(value: unknown): EditorStyleEnvironment | null {
  if (!isRecord(value)) return null;
  if ('previewFontFamilyName' in value
    || 'previewFontFamilyFallback' in value
    || 'previewFontFamilies' in value) return null;
  if (value.previewFontFamily !== undefined
    && normalizePreviewFontFamily(value.previewFontFamily) === null) return null;
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
  if (value.previewSourceColoring !== undefined && typeof value.previewSourceColoring !== 'boolean') return null;
  if (value.previewCodePalettes !== undefined) {
    if (!isRecord(value.previewCodePalettes)) return null;
    for (const appearance of ['light', 'dark'] as const) {
      const palette = value.previewCodePalettes[appearance];
      if (!isRecord(palette)
        || ['foreground', 'comment', 'keyword', 'string', 'number', 'type', 'property', 'link']
          .some((key) => typeof palette[key] !== 'string')) return null;
    }
  }
  return value.previewFontFamily === undefined
    ? value as EditorStyleEnvironment
    : { ...value, previewFontFamily: normalizePreviewFontFamily(value.previewFontFamily) as string };
}
