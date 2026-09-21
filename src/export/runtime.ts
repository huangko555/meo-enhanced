import { renderMarkdownToHtml } from './renderMarkdown';
import { buildExportHtmlDocument as buildStandaloneExportHtmlDocument } from './exportHtmlTemplate';
import { buildExportStyles, buildPreviewStyles, type ExportStyleEnvironment } from './exportStyles';
import { writeHtmlExport } from './htmlExport';
import { renderPdfFromHtmlExport } from './pdfRenderer';
import { writeDocxExport } from './docxRenderer';
import type { PreviewAppearance, PreviewRenderResult } from '../shared/preview';
import type { ReadingSnapshot } from '../protocol/exportSnapshot';
import type { CodeThemeDto } from '../protocol/hostConfigurationEvents';
import { createExportCodeHighlighter } from './shikiCodeHighlighter';

export type ExportRuntimeBuildHtmlOptions = {
  readingSnapshot: ReadingSnapshot;
  sourceDocumentPath: string;
  outputFilePath: string;
  target: 'html' | 'pdf' | 'docx';
  mermaidRuntimeSrc: string;
  katexStylesHref?: string;
  baseHref: string;
  title: string;
  includeTableOfContents?: boolean;
  shikiLanguageAssetsRoot: string;
};

async function renderExportHtmlDocument(
  options: ExportRuntimeBuildHtmlOptions
): Promise<{ htmlDocument: string; hasMermaid: boolean; hasMath: boolean }> {
  const snapshot = options.readingSnapshot;
  const exportAppearance = options.target === 'docx' ? 'light' : snapshot.appearance;
  const fallbackTheme = options.target === 'docx'
    ? (await import('@shikijs/themes/light-plus')).default as CodeThemeDto
    : snapshot.codeTheme ?? (exportAppearance === 'light'
      ? (await import('@shikijs/themes/light-plus')).default as CodeThemeDto
      : (await import('@shikijs/themes/dark-plus')).default as CodeThemeDto);
  const highlighter = snapshot.environment.previewSourceColoring === false
    ? null
    : await createExportCodeHighlighter(snapshot.text, fallbackTheme, options.shikiLanguageAssetsRoot);
  let rendered: ReturnType<typeof renderMarkdownToHtml>;
  try {
    rendered = renderMarkdownToHtml({
      markdownText: snapshot.text,
      markdownFilePath: options.sourceDocumentPath,
      outputFilePath: options.outputFilePath,
      target: options.target,
      uiLanguage: snapshot.uiLanguage,
      includeTableOfContents: options.target !== 'docx' && options.includeTableOfContents === true,
      ...(highlighter ? { highlightCode: highlighter.highlight } : {})
    });
  } finally {
    highlighter?.dispose();
  }
  const { html: bodyHtml, hasMermaid, hasMath } = rendered;

  const stylesCss = buildExportStyles(snapshot.environment, exportAppearance);

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
  uiLanguage: ReadingSnapshot['uiLanguage'];
  styleEnvironment?: ExportStyleEnvironment;
}): PreviewRenderResult {
  const rendered = renderMarkdownToHtml({
    markdownText: options.markdownText,
    markdownFilePath: options.sourceDocumentPath,
    target: 'html',
    uiLanguage: options.uiLanguage,
    deferImages: true
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
  renderPdfFromHtmlExport,
  writeDocxExport
};

export default exportRuntime;
export type { ExportStyleEnvironment };
