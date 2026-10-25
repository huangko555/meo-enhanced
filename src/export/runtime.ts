import { prepareMarkdownPresentation, renderMarkdownToHtml } from './renderMarkdown';
import { buildExportHtmlDocument as buildStandaloneExportHtmlDocument } from './exportHtmlTemplate';
import { buildExportStyles, type ExportStyleEnvironment } from './exportStyles';
import { writeHtmlExport } from './htmlExport';
import { renderPdfFromHtmlExport } from './pdfRenderer';
import { buildPdfExportStyles } from './pdfStyles';
import { writeDocxExport } from './docxRenderer';
import type { PreviewAppearance, PreviewRenderResult } from '../shared/preview';
import type { ReadingSnapshot } from '../protocol/exportSnapshot';
import type { CodeThemeDto } from '../protocol/hostConfigurationEvents';
import { createExportCodeHighlighter } from './shikiCodeHighlighter';
import { getPreviewPreset, getPreviewPresetCodeTheme, resolvePresetAppearance, resolvePreviewPresetSettings, type PreviewPresetId, type PreviewContentWidth, type PreviewPresetDefinition } from '../foundation/previewPresets';
import { buildPresetPreviewStyles } from '../preview/presetStyles';
import type { ResolvedWikiResources } from '../foundation/wikiReference';
import { githubPictureMedia } from '../shared/githubPicture';
import { assessLargeDocument } from '../foundation/largeDocument';

export type ExportRuntimeBuildHtmlOptions = {
  wikiResources?: ResolvedWikiResources;
  readingSnapshot: ReadingSnapshot;
  presetDefinition?: PreviewPresetDefinition;
  sourceDocumentPath: string;
  imageSearchRoots?: readonly string[];
  workspaceRootPath?: string;
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
  const preset = options.target === 'docx' ? 'default' : snapshot.preset ?? 'default';
  // Capture the definition before asynchronous highlighting; updates cannot change this export.
  const definition = options.target === 'docx' ? getPreviewPreset('default') : options.presetDefinition ?? getPreviewPreset(preset);
  if (definition.id !== preset) throw new Error('Export preset does not match its snapshot');
  const githubStyle = definition.custom?.base === 'github-readme' || definition.renderer === 'github-readme';
  const exportAppearance = options.target === 'docx' ? 'light' : resolvePresetAppearance(definition, snapshot.appearance, snapshot.appearance);
  const styleEnvironment = options.target === 'docx' ? snapshot.environment
    : { ...snapshot.environment, previewFontFamily: snapshot.presetFontFamily ?? snapshot.environment.previewFontFamily, previewCodeFontFamily: snapshot.presetCodeFontFamily ?? snapshot.environment.previewCodeFontFamily };
  const environment = options.target === 'docx' ? styleEnvironment
    : { ...styleEnvironment, ...resolvePreviewPresetSettings(preset, styleEnvironment, definition) };
  const namedTheme = getPreviewPresetCodeTheme(definition, exportAppearance);
  const fallbackTheme = namedTheme
    ? (await importPresetCodeTheme(namedTheme))
    : options.target === 'docx' || !snapshot.codeTheme
    ? (await importPresetCodeTheme(options.target === 'docx' || exportAppearance === 'light' ? 'light-plus' : 'dark-plus'))
    : snapshot.codeTheme;
  const highlighter = environment.previewSourceColoring === false
    ? null
    : await createExportCodeHighlighter(snapshot.text, fallbackTheme, options.shikiLanguageAssetsRoot, !githubStyle && !namedTheme);
  let rendered: ReturnType<typeof renderMarkdownToHtml>;
  try {
    rendered = renderMarkdownToHtml({
      wikiResources: options.wikiResources,
      markdownText: snapshot.text,
      markdownFilePath: options.sourceDocumentPath,
      imageSearchRoots: options.imageSearchRoots,
      workspaceRootPath: options.workspaceRootPath,
      outputFilePath: options.outputFilePath,
      target: options.target,
      uiLanguage: snapshot.uiLanguage,
      showComments: environment.previewShowComments === true,
      allowLocalLinks: true,
      preset,
      presetDefinition: definition,
      includeTableOfContents: options.target !== 'docx' && options.includeTableOfContents === true,
      ...(highlighter ? { highlightCode: highlighter.highlight } : {})
    });
  } finally {
    highlighter?.dispose();
  }
  const { html: bodyHtml, hasMermaid, hasMath } = rendered;

  const stylesCss = options.target === 'docx'
    ? buildExportStyles(environment, 'light')
    : buildPresetPreviewStyles(preset, environment, exportAppearance, 'responsive', definition);

  const htmlDocument = buildStandaloneExportHtmlDocument({
    title: options.title,
    bodyHtml: definition.renderer === 'github-readme'
      ? bodyHtml.replace(/(<source\b[^>]*\bmedia=")([^"]*)(")/g, (_match, before, media, after) => `${before}${githubPictureMedia(media, exportAppearance)}${after}`)
      : bodyHtml,
    stylesCss: options.target === 'pdf' ? buildPdfExportStyles(stylesCss) : stylesCss,
    target: options.target,
    githubStyle,
    githubMermaid: definition.renderer === 'github-readme',
    hasMermaid,
    hasMath,
    mermaidRuntimeSrc: options.mermaidRuntimeSrc,
    katexStylesHref: options.katexStylesHref,
    baseHref: options.baseHref
  });

  return { htmlDocument, hasMermaid, hasMath };
}

export type PreviewDocumentOptions = {
  wikiResources?: ResolvedWikiResources;
  markdownText: string;
  sourceDocumentPath: string;
  uiLanguage: ReadingSnapshot['uiLanguage'];
  styleEnvironment?: ExportStyleEnvironment;
  preset?: PreviewPresetId;
  presetDefinition?: PreviewPresetDefinition;
  contentWidth?: PreviewContentWidth;
};

export function renderPreviewDocument(options: PreviewDocumentOptions): PreviewRenderResult {
  return preparePreviewDocument(options).renderAll();
}

export function preparePreviewDocument(options: PreviewDocumentOptions, windowed = false) {
  const preset = options.preset ?? 'default';
  const definition = options.presetDefinition ?? getPreviewPreset(preset);
  if (definition.id !== preset) throw new Error('Preview preset does not match its request');
  const environment = {
    ...options.styleEnvironment,
    ...resolvePreviewPresetSettings(preset, options.styleEnvironment ?? { previewFontFamily: '' }, definition)
  };
  const prepared = prepareMarkdownPresentation({
    wikiResources: options.wikiResources,
    markdownText: options.markdownText,
    markdownFilePath: options.sourceDocumentPath,
    target: 'html',
    uiLanguage: options.uiLanguage,
    showComments: environment.previewShowComments === true,
    deferImages: true,
    deferDisplayMath: assessLargeDocument(options.markdownText).windowedPreview,
    windowedPresentation: windowed,
    deferLocalLinks: true,
    allowLocalLinks: true,
    preset,
    presetDefinition: definition
  });
  const presentation = {
    preset,
    ...(definition.custom ? { presetRevision: definition.custom.revision } : {}),
    styles: {
      dark: buildPresetPreviewStyles(preset, environment, 'dark', options.contentWidth, definition)
        + (windowed ? windowedPreviewStyles : ''),
      light: buildPresetPreviewStyles(preset, environment, 'light', options.contentWidth, definition)
        + (windowed ? windowedPreviewStyles : '')
    }
  };
  return {
    ...presentation,
    blocks: prepared.blocks,
    hasMermaid: prepared.hasMermaid,
    headings: prepared.headings,
    codeSources: prepared.codeSources,
    renderBlock: prepared.renderBlock,
    renderAll: (): PreviewRenderResult => {
      const rendered = prepared.renderAll();
      return { html: rendered.html, hasMermaid: rendered.hasMermaid, ...presentation };
    }
  };
}

const windowedPreviewStyles = `
.meo-export-doc [data-meo-container-part]:not([data-meo-container-part="end"]){margin-bottom:0}
.meo-export-doc [data-meo-container-part]:not([data-meo-container-part="start"]){margin-top:0}
html[data-meo-preview-preset="default"] .meo-export-doc :is(ul,ol)[data-meo-container-part]:not([data-meo-container-part="start"])>li:first-child{margin-top:.2em}
.meo-export-doc blockquote[data-meo-container-part]{display:flow-root}
.meo-export-doc blockquote[data-meo-container-part]:not([data-meo-container-part="end"]){padding-bottom:0}
.meo-export-doc blockquote[data-meo-container-part]:not([data-meo-container-part="start"]){padding-top:0}
.meo-export-doc blockquote[data-meo-container-part]:not([data-meo-container-part="end"])>p:last-child{margin-bottom:1em}
html[data-meo-preview-preset="newsprint"] .meo-export-doc blockquote[data-meo-container-part]:not([data-meo-container-part="end"])>p:last-child{margin-bottom:1.35em}
.footnotes.meo-preview-footnotes-continuation{margin-top:.45em!important;padding-top:0!important;border-top:0!important}
.meo-table-scroll:has(>table[data-meo-preview-table-part]){margin-bottom:0}
.meo-table-scroll:has(>table[data-meo-preview-table-part="end"]){margin-bottom:1em}
table:is([data-meo-preview-table-part="middle"],[data-meo-preview-table-part="end"])>tbody>tr:first-child>td{border-top-width:0}
.meo-export-code-block-wrap[data-meo-code-part]{margin-bottom:0}
.meo-export-code-block-wrap[data-meo-code-part="end"]{margin-bottom:1em}
.meo-export-code-block-wrap:is([data-meo-code-part="start"],[data-meo-code-part="middle"])>pre{padding-bottom:0;border-bottom:0;border-bottom-left-radius:0;border-bottom-right-radius:0}
.meo-export-code-block-wrap:is([data-meo-code-part="middle"],[data-meo-code-part="end"])>pre{padding-top:0;border-top:0;border-top-left-radius:0;border-top-right-radius:0}
${Array.from({ length: 8 }, (_, index) => `[data-meo-code-digits="${index + 3}"] .meo-export-code-line{grid-template-columns:${index + 3}ch minmax(0,1fr)}`).join('\n')}
`;

async function importPresetCodeTheme(name: string): Promise<CodeThemeDto> {
  switch (name) {
    case 'dark-plus': return (await import('@shikijs/themes/dark-plus')).default as CodeThemeDto;
    case 'github-light-default': return (await import('@shikijs/themes/github-light-default')).default as CodeThemeDto;
    case 'github-dark-default': return (await import('@shikijs/themes/github-dark-default')).default as CodeThemeDto;
    default: return (await import('@shikijs/themes/light-plus')).default as CodeThemeDto;
  }
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
