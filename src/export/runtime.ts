import { renderMarkdownToHtml } from './renderMarkdown';
import { buildExportHtmlDocument as buildStandaloneExportHtmlDocument } from './exportHtmlTemplate';
import { buildExportStyles, buildPreviewStyles, type ExportStyleEnvironment } from './exportStyles';
import { writeFinalizedHtmlExport } from './htmlExport';
import { renderPdfFromHtmlExport } from './pdfRenderer';
import type { ExportHtmlImageMode } from './assetPaths';
import type { ThemeSettings } from '../shared/themeDefaults';
import type { PreviewAppearance, PreviewRenderResult } from '../shared/preview';

export type ExportRuntimeBuildHtmlOptions = {
  markdownText: string;
  sourceDocumentPath: string;
  outputFilePath: string;
  target: 'html' | 'pdf';
  htmlImageMode: ExportHtmlImageMode;
  theme: ThemeSettings;
  appearance: PreviewAppearance;
  styleEnvironment?: ExportStyleEnvironment;
  editorFontEnvironment?: {
    editorFontFamily?: string;
    editorFontWeight?: string;
    editorFontSizePx?: number;
  };
  mermaidRuntimeSrc: string;
  katexStylesHref?: string;
  baseHref: string;
  title: string;
};

function renderExportHtmlDocument(
  options: ExportRuntimeBuildHtmlOptions
): { htmlDocument: string; hasMermaid: boolean; hasMath: boolean } {
  const { html: bodyHtml, hasMermaid, hasMath } = renderMarkdownToHtml({
    markdownText: options.markdownText,
    markdownFilePath: options.sourceDocumentPath,
    outputFilePath: options.outputFilePath,
    target: options.target,
    htmlImageMode: options.htmlImageMode
  });

  const stylesCss = buildExportStyles(
    options.theme,
    {
      ...(options.editorFontEnvironment ?? {}),
      ...(options.styleEnvironment ?? {})
    },
    options.appearance
  );

  const htmlDocument = buildStandaloneExportHtmlDocument({
    title: options.title,
    bodyHtml,
    stylesCss,
    target: options.target,
    hasMermaid,
    hasMath,
    mermaidRuntimeSrc: options.mermaidRuntimeSrc,
    katexStylesHref: options.katexStylesHref,
    baseHref: options.baseHref
  });

  return { htmlDocument, hasMermaid, hasMath };
}

function renderPreviewDocument(options: {
  markdownText: string;
  sourceDocumentPath: string;
  theme: ThemeSettings;
  styleEnvironment?: ExportStyleEnvironment;
}): PreviewRenderResult {
  const rendered = renderMarkdownToHtml({
    markdownText: options.markdownText,
    markdownFilePath: options.sourceDocumentPath,
    target: 'html',
    htmlImageMode: 'embedded'
  });
  return {
    html: rendered.html,
    hasMermaid: rendered.hasMermaid,
    styles: {
      dark: buildPreviewStyles(options.theme, options.styleEnvironment, 'dark'),
      light: buildPreviewStyles(options.theme, options.styleEnvironment, 'light')
    }
  };
}

const exportRuntime = {
  renderExportHtmlDocument,
  renderPreviewDocument,
  writeFinalizedHtmlExport,
  renderPdfFromHtmlExport
};

export default exportRuntime;
export type { ExportStyleEnvironment };
