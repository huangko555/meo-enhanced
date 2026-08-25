import { renderMarkdownToHtml } from './renderMarkdown';
import { buildExportHtmlDocument as buildStandaloneExportHtmlDocument } from './exportHtmlTemplate';
import { buildExportStyles, buildPreviewStyles, type ExportStyleEnvironment } from './exportStyles';
import { writeHtmlExport } from './htmlExport';
import { renderPdfFromHtmlExport } from './pdfRenderer';
import type { PreviewAppearance, PreviewRenderResult } from '../shared/preview';
import type { ReadingSnapshot } from '../protocol/exportSnapshot';

export type ExportRuntimeBuildHtmlOptions = {
  readingSnapshot: ReadingSnapshot;
  sourceDocumentPath: string;
  outputFilePath: string;
  target: 'html' | 'pdf';
  mermaidRuntimeSrc: string;
  katexStylesHref?: string;
  baseHref: string;
  title: string;
};

function renderExportHtmlDocument(
  options: ExportRuntimeBuildHtmlOptions
): { htmlDocument: string; hasMermaid: boolean; hasMath: boolean } {
  const snapshot = options.readingSnapshot;
  const { html: bodyHtml, hasMermaid, hasMath } = renderMarkdownToHtml({
    markdownText: snapshot.text,
    markdownFilePath: options.sourceDocumentPath,
    outputFilePath: options.outputFilePath,
    target: options.target
  });

  const stylesCss = buildExportStyles(snapshot.environment, snapshot.appearance);

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
  styleEnvironment?: ExportStyleEnvironment;
}): PreviewRenderResult {
  const rendered = renderMarkdownToHtml({
    markdownText: options.markdownText,
    markdownFilePath: options.sourceDocumentPath,
    target: 'html',
    renderHexColorSwatches: true
  });
  return {
    html: rendered.html,
    hasMermaid: rendered.hasMermaid,
    styles: {
      dark: buildPreviewStyles(options.styleEnvironment, 'dark'),
      light: buildPreviewStyles(options.styleEnvironment, 'light')
    }
  };
}

const exportRuntime = {
  renderExportHtmlDocument,
  renderPreviewDocument,
  writeHtmlExport,
  renderPdfFromHtmlExport
};

export default exportRuntime;
export type { ExportStyleEnvironment };
