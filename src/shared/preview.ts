export type PreviewAppearance = 'dark' | 'light';

export const PREVIEW_APPEARANCE_STATE_KEY = 'previewAppearance';

export function normalizePreviewAppearance(value: unknown): PreviewAppearance {
  return value === 'light' ? 'light' : 'dark';
}

export type PreviewStyles = Record<PreviewAppearance, string>;

export type PreviewStyleEnvironment = {
  editorFontFamily?: string;
  editorFontSizePx?: number;
  editorFontWeight?: string;
  editorBackgroundColor?: string;
  editorForegroundColor?: string;
  codeBlockBackgroundColor?: string;
  sideBarBackgroundColor?: string;
  panelBorderColor?: string;
  liveFontFamily?: string;
  sourceFontFamily?: string;
  liveFontWeight?: string;
  sourceFontWeight?: string;
  liveLineHeight?: number;
  sourceLineHeight?: number;
  meoThemeColors?: Record<string, string>;
};

export type PreviewRenderResult = {
  html: string;
  hasMermaid: boolean;
  styles: PreviewStyles;
};
