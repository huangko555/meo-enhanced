export type PreviewAppearance = 'auto' | 'dark' | 'light';
export type ResolvedPreviewAppearance = Exclude<PreviewAppearance, 'auto'>;

export const PREVIEW_APPEARANCE_STATE_KEY = 'previewAppearance';

export function normalizePreviewAppearance(value: unknown): PreviewAppearance {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

export type PreviewStyles = Record<ResolvedPreviewAppearance, string>;

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
