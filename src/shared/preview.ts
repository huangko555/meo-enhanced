export type PreviewAppearance = 'dark' | 'light';

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

export type PreviewRenderRequestMessage = {
  type: 'requestPreviewRender';
  requestId: string;
  text: string;
  environment?: PreviewStyleEnvironment;
};

export type PreviewRenderedMessage = PreviewRenderResult & {
  type: 'previewRendered';
  requestId: string;
};

export type PreviewRenderErrorMessage = {
  type: 'previewRenderError';
  requestId: string;
  message: string;
};
