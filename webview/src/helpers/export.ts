import { defaultCodeBlockBackgroundColor, themeColorKeys } from '../../../src/shared/builtInVisualBaseline';
import type { PreviewCodePalette } from '../application/finalCodePalette';
import { documentSurfaceVariables } from '../../../src/shared/documentSurfaceRoles';

export interface ExportStyleEnvironment extends Record<string, unknown> {
  editorBackgroundColor: string;
  editorForegroundColor: string;
  codeBlockBackgroundColor: string;
  sideBarBackgroundColor: string;
  panelBorderColor: string;
  frontmatterKeyColor: string;
  frontmatterValueColor: string;
  frontmatterPillBackgroundColor: string;
  editorFontFamily: string;
  editorFontWeight: string;
  editorFontSizePx: number | undefined;
  previewFontFamily: string;
  previewCodeFontFamily: string;
  liveFontWeight: string;
  sourceFontWeight: string;
  liveLineHeight: number | undefined;
  sourceLineHeight: number | undefined;
  meoThemeColors: Record<string, string>;
  previewSourceColoring: boolean;
  previewShowComments: boolean;
  previewThemeIsolation: boolean;
  previewCodePalettes: Readonly<Record<'light' | 'dark', PreviewCodePalette>>;
}

export const getExportStyleEnvironment = (code: {
  readonly previewFontFamily: string;
  readonly previewCodeFontFamily?: string;
  readonly previewSourceColoring: boolean;
  readonly previewShowComments: boolean;
  readonly previewCodePalettes: Readonly<Record<'light' | 'dark', PreviewCodePalette>>;
  readonly captureDocumentSurfaces?: boolean;
}): ExportStyleEnvironment => {
  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const editorEl = document.querySelector('.cm-editor');
  const editorStyles = editorEl ? getComputedStyle(editorEl) : null;

  const colorVar = (name: string, fallback = ''): string => {
    const value = rootStyles.getPropertyValue(name.replace('--vscode-', '--meo-content-')).trim()
      || rootStyles.getPropertyValue(name).trim();
    return value || fallback;
  };
  const resolvedColorVar = (name: string, fallback = ''): string => {
    const value = colorVar(name);
    return /^var\(/i.test(value) ? fallback : value || fallback;
  };
  const semanticColor = (name: string, fallbackVariable: string, fallback = ''): string => {
    const value = colorVar(`--meo-semantic-${name}`);
    return value && !/\bvar\(/i.test(value) ? value : resolvedColorVar(fallbackVariable, fallback);
  };

  const customEditorFontSizeRaw = rootStyles.getPropertyValue('--meo-user-editor-font-size').trim();
  const editorFontSizeRaw = customEditorFontSizeRaw || rootStyles.getPropertyValue('--vscode-editor-font-size').trim();
  // Preview can preload before CodeMirror mounts. Use the document typography
  // in that state too, so the first edit does not switch from body to editor size.
  const documentFontSizeRaw = rootStyles.getPropertyValue('--meo-font-live-size').trim();
  const fontSizeRaw = editorFontSizeRaw || documentFontSizeRaw || (editorStyles?.fontSize || bodyStyles.fontSize || '').trim();
  const parsedFontSize = Number.parseFloat(fontSizeRaw);
  const editorFontFamilyRaw = rootStyles.getPropertyValue('--vscode-editor-font-family').trim();
  const capturedEditorFontFamily = /^var\(/i.test(editorFontFamilyRaw)
    ? (editorStyles?.fontFamily || bodyStyles.fontFamily || '').trim()
    : editorFontFamilyRaw || (editorStyles?.fontFamily || bodyStyles.fontFamily || '').trim();
  const editorFontWeightRaw = rootStyles.getPropertyValue('--vscode-editor-font-weight').trim();
  const lineHeightLiveRaw = rootStyles.getPropertyValue('--meo-line-height-live').trim();
  const lineHeightSourceRaw = rootStyles.getPropertyValue('--meo-line-height-source').trim();
  const parsedLiveLineHeight = Number.parseFloat(lineHeightLiveRaw);
  const parsedSourceLineHeight = Number.parseFloat(lineHeightSourceRaw);
  const meoThemeColors: Record<string, string> = {};
  for (const key of themeColorKeys) {
    const value = rootStyles.getPropertyValue(`--meo-color-${key}`).trim();
    if (value) {
      meoThemeColors[key] = value;
    }
  }
  if (code.captureDocumentSurfaces) {
    for (const role of new Set(Object.values(documentSurfaceVariables))) {
      meoThemeColors['document-' + role] = colorVar('--meo-document-' + role);
    }
  }
  const editorForegroundColor = resolvedColorVar(
    '--meo-color-base01',
    editorStyles?.color || bodyStyles.color || colorVar('--vscode-editor-foreground', '')
  );

  return {
    editorBackgroundColor: bodyStyles.backgroundColor,
    editorForegroundColor,
    codeBlockBackgroundColor: resolvedColorVar(
      '--meo-code-background',
      colorVar('--vscode-sideBar-background', defaultCodeBlockBackgroundColor)
    ),
    sideBarBackgroundColor: resolvedColorVar('--meo-surface-background', colorVar('--vscode-sideBar-background', '')),
    panelBorderColor: colorVar('--vscode-panel-border', ''),
    frontmatterKeyColor: semanticColor('frontmatterKey', '--meo-color-base07', editorForegroundColor),
    frontmatterValueColor: semanticColor('frontmatterValue', '--meo-color-base01', editorForegroundColor),
    frontmatterPillBackgroundColor: semanticColor(
      'frontmatterPillBackground',
      '--meo-color-base03',
      colorVar('--vscode-panel-border', '')
    ),
    editorFontFamily: capturedEditorFontFamily,
    editorFontWeight: editorFontWeightRaw || 'normal',
    editorFontSizePx: Number.isFinite(parsedFontSize) ? parsedFontSize : undefined,
    previewFontFamily: code.previewFontFamily,
    previewCodeFontFamily: code.previewCodeFontFamily ?? '',
    liveFontWeight: colorVar('--meo-font-live-weight', ''),
    sourceFontWeight: colorVar('--meo-font-source-weight', ''),
    liveLineHeight: Number.isFinite(parsedLiveLineHeight) ? parsedLiveLineHeight : undefined,
    sourceLineHeight: Number.isFinite(parsedSourceLineHeight) ? parsedSourceLineHeight : undefined,
    meoThemeColors,
    previewSourceColoring: code.previewSourceColoring,
    previewShowComments: code.previewShowComments,
    previewThemeIsolation: true,
    previewCodePalettes: code.previewCodePalettes
  };
};
