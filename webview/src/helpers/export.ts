import { defaultCodeBlockBackgroundColor, themeColorKeys } from '../../../src/shared/builtInVisualBaseline';
import type { PreviewCodePalette } from '../application/finalCodePalette';

export interface ExportStyleEnvironment extends Record<string, unknown> {
  editorBackgroundColor: string;
  editorForegroundColor: string;
  codeBlockBackgroundColor: string;
  sideBarBackgroundColor: string;
  panelBorderColor: string;
  editorFontFamily: string;
  editorFontWeight: string;
  editorFontSizePx: number | undefined;
  previewFontFamily: string;
  liveFontWeight: string;
  sourceFontWeight: string;
  liveLineHeight: number | undefined;
  sourceLineHeight: number | undefined;
  meoThemeColors: Record<string, string>;
  previewSourceColoring: boolean;
  previewCodePalettes: Readonly<Record<'light' | 'dark', PreviewCodePalette>>;
}

export const getExportStyleEnvironment = (code: {
  readonly previewFontFamily: string;
  readonly previewSourceColoring: boolean;
  readonly previewCodePalettes: Readonly<Record<'light' | 'dark', PreviewCodePalette>>;
}): ExportStyleEnvironment => {
  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const editorEl = document.querySelector('.cm-editor');
  const editorStyles = editorEl ? getComputedStyle(editorEl) : null;

  const colorVar = (name: string, fallback = ''): string => {
    const value = rootStyles.getPropertyValue(name).trim();
    return value || fallback;
  };
  const resolvedColorVar = (name: string, fallback = ''): string => {
    const value = colorVar(name);
    return /^var\(/i.test(value) ? fallback : value || fallback;
  };

  const customEditorFontSizeRaw = rootStyles.getPropertyValue('--meo-user-editor-font-size').trim();
  const editorFontSizeRaw = customEditorFontSizeRaw || rootStyles.getPropertyValue('--vscode-editor-font-size').trim();
  const fontSizeRaw = editorFontSizeRaw || (editorStyles?.fontSize || bodyStyles.fontSize || '').trim();
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

  return {
    editorBackgroundColor: resolvedColorVar(
      '--meo-background',
      colorVar('--vscode-editor-background', bodyStyles.backgroundColor || '')
    ),
    editorForegroundColor: resolvedColorVar(
      '--meo-color-base01',
      editorStyles?.color || bodyStyles.color || colorVar('--vscode-editor-foreground', '')
    ),
    codeBlockBackgroundColor: resolvedColorVar(
      '--meo-code-background',
      colorVar('--vscode-sideBar-background', defaultCodeBlockBackgroundColor)
    ),
    sideBarBackgroundColor: resolvedColorVar('--meo-surface-background', colorVar('--vscode-sideBar-background', '')),
    panelBorderColor: colorVar('--vscode-panel-border', ''),
    editorFontFamily: capturedEditorFontFamily,
    editorFontWeight: editorFontWeightRaw || 'normal',
    editorFontSizePx: Number.isFinite(parsedFontSize) ? parsedFontSize : undefined,
    previewFontFamily: code.previewFontFamily,
    liveFontWeight: colorVar('--meo-font-live-weight', ''),
    sourceFontWeight: colorVar('--meo-font-source-weight', ''),
    liveLineHeight: Number.isFinite(parsedLiveLineHeight) ? parsedLiveLineHeight : undefined,
    sourceLineHeight: Number.isFinite(parsedSourceLineHeight) ? parsedSourceLineHeight : undefined,
    meoThemeColors,
    previewSourceColoring: code.previewSourceColoring,
    previewCodePalettes: code.previewCodePalettes
  };
};
