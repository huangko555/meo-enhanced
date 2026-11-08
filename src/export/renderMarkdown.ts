import { markdownHeadingAnchor } from '../foundation/markdownHeadingAnchor';
import { markdownTaskMarkerPattern } from '../foundation/markdownTaskList';
import { normalizeLinkDestination, isLocalFileLinkDestination } from '../foundation/linkDestination';
import { splitMarkdownTableRow } from '../foundation/markdownTableRow';
import * as path from 'node:path';
import type MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { Parser, parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';
import { isLocalImageSrc, rewriteExportImageSrc, rewriteExportLinkHref } from './assetPaths';
import { extractExportFrontmatter } from './frontmatter';
import { prepareMarkdownWithFootnotes, sourceFootnoteMarker } from './footnotes';
import type { SourceMappedMarkdown } from './sourceMappedMarkdown';
import { installMathTransform } from './mathTransform';
import { collectMarkdownCodeLines } from './markdownCodeLines';
import { renderLatexMathPresentation } from './math';
import { isMathFenceLanguage, mathFenceBodyRange, mathFenceContent } from '../shared/mathFence';
import { createMarkdownContentParser } from '../shared/markdownContentParser';
import { canRepairMarkdownTableDelimiter } from '../shared/markdownContentRules';
import { Info, Lightbulb, AlertCircle, AlertTriangle, XCircle } from 'lucide';
import {
  getSupportedHtmlAttributes,
  isSupportedHtmlSource,
  sanitizeHtmlStyle,
  htmlSanitizedStyleRules,
  supportedHtmlTags, normalizeHtmlAttribute, mapHtmlSrcset, getHtmlTagNames, getHtmlRootTagName,
  renderedHtmlTagNames, canonicalHtmlTagName, canonicalHtmlAttributeName
} from '../shared/htmlPolicy';
import { inspectHtmlStylesheets } from '../shared/htmlStylesheet';
import { splitHtmlBlockFragments } from '../foundation/htmlSyntax';
import type { UiLanguage } from '../foundation/uiLanguage';
import { getReadingUiStrings } from './readingUiLanguage';
import { normalizeFenceLanguage } from './fenceLanguage';
import { markdownPresentationBlocks, type MarkdownPresentationBlock } from './markdownPresentationBlocks';
import { prepareDeferredMarkdownInline } from './deferredMarkdownInline';
import { splitMarkdownTableBands, renderTableBandTokens, isMarkdownTableBand } from './markdownTableBands';
import { splitMarkdownCodeBands, renderCodeBandToken, isMarkdownCodeBand, type CodeBand } from './markdownCodeBands';
import { splitMarkdownContainerBands, renderContainerBandTokens, isMarkdownContainerBand } from './markdownContainerBands';
import type { PreviewCodeSource } from '../foundation/previewDocument';
import type { PreviewDocumentHeading } from '../foundation/previewDocument';
import { getPreviewPreset, type PreviewPresetId, type PreviewPresetDefinition } from '../foundation/previewPresets';
import { load as loadYaml } from 'js-yaml';
import { installWikiReferenceTransform } from './wikiReferences';
import type { ResolvedWikiResources } from '../foundation/wikiReference';
import { addGithubDetailsSummary, createGithubHtmlSanitizer, githubHtmlAttributes, githubHtmlTags, installGithubInlineRules, isGithubImageSource, isGithubLink, linkifyGithubFilteredHtml, replaceGithubEmoji, stripGithubSelectMarkup } from './githubReadme';

const taskContentPrefix = new RegExp(String.raw`^${markdownTaskMarkerPattern}\s+`);
const OPENING_KBD_TAG_RE = /^<kbd\b[^>]*>$/i;
const CLOSING_KBD_TAG_RE = /^<\/kbd\s*>$/i;
const DEFERRED_IMAGE_ATTRIBUTE = 'data-meo-deferred-image-src';
const DEFERRED_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function renderedHtmlAttributes(trusted: Record<string, string[]>, github: boolean): Record<string, string[]> {
  if (github) return trusted;
  const result = { ...trusted };
  for (const tag of renderedHtmlTagNames) {
    result[tag] = [...new Set([...getSupportedHtmlAttributes(tag), ...(trusted[tag] ?? [])])];
  }
  return result;
}

// The Host is emitted as CommonJS. Its build retains only this synchronous,
// data-only registry; grammar loading remains in the existing Shiki worker.
const { languageNames, languageAliasNames } = require('@shikijs/langs') as {
  languageNames: readonly string[];
  languageAliasNames: readonly string[];
};
const viewportCodeLanguages = new Set([...languageNames, ...languageAliasNames]);

export type RenderMarkdownTarget = 'html' | 'pdf' | 'docx';

export type RenderMarkdownOptions = {
  /** Inert, compact content for read-only canvases. Shares ordinary parsing and source maps. */
  contentOnly?: boolean;
  /** Side Preview keeps definitions in the source reading flow. */
  sourceFootnotes?: boolean;
  wikiResources?: ResolvedWikiResources;
  markdownText: string;
  latexDelimiters?: boolean;
  markdownFilePath: string;
  imageSearchRoots?: readonly string[];
  workspaceRootPath?: string;
  outputFilePath?: string;
  target: RenderMarkdownTarget;
  uiLanguage?: UiLanguage;
  includeTableOfContents?: boolean;
  /** Preview resolves local and network images after the reading frame is ready. */
  deferImages?: boolean;
  /** Preview leaves workspace-root links for Host URI resolution. */
  deferLocalLinks?: boolean;
  /** Large Preview generates display formulas in its existing viewport observer. */
  deferDisplayMath?: boolean;
  /** Prepared Preview contexts defer inline roots and expose individual endnotes. */
  windowedPresentation?: boolean;
  /** Interactive Preview projects large code syntax only around the viewport. */
  deferCodeHighlight?: boolean;
  /** Permit local file destinations alongside the preset's safe URL schemes. */
  allowLocalLinks?: boolean;
  showComments?: boolean;
  /** Standalone exports inject the same Shiki token presentation used by Live and Preview. */
  highlightCode?: (source: string, language: string) => string;
  exportBlockLanguages?: readonly string[];
  /** Selects rendering semantics for Preview and HTML/PDF export. */
  preset?: PreviewPresetId;
  presetDefinition?: PreviewPresetDefinition;
};

export type RenderMarkdownResult = {
  html: string;
  hasMermaid: boolean;
  hasMath: boolean;
};

type ExportHeading = Readonly<{
  level: number;
  id: string;
  text: string;
  line: number;
}>;

export type MarkdownPresentation = Readonly<{
  authorStyles: string;
  blocks: readonly MarkdownPresentationBlock[];
  hasMermaid: boolean;
  headings: readonly PreviewDocumentHeading[];
  codeSources: readonly PreviewCodeSource[];
  anchors: readonly Readonly<{ id: string; sourceLine: number }>[];
  renderBlock(index: number): RenderMarkdownResult;
  renderAll(): RenderMarkdownResult;
}>;

export function renderMarkdownToHtml(options: RenderMarkdownOptions): RenderMarkdownResult {
  return prepareMarkdownPresentation(options).renderAll();
}

/** Parse global Markdown context once. HTML generation is a separate, demand-driven step. */
export function prepareMarkdownPresentation(options: RenderMarkdownOptions): MarkdownPresentation {
  const github = (options.presetDefinition ?? getPreviewPreset(options.preset)).renderer === 'github-readme';
  // GitHub owns its math syntax; editor preferences only extend the MEO renderer.
  const latexDelimiters = !github && options.latexDelimiters === true;
  const uiStrings = getReadingUiStrings(options.uiLanguage ?? 'en');
  let hasMermaid = false;
  let hasMath = false;
  let bodySourceLines: number[] | null = null;
  const headings: ExportHeading[] = [];
  const embeddedImageDataUrlCache = new Map<string, string | null>();
  const generatedFootnoteTags = new Set<string>();
  const rewriteImageSrc = (rawSrc: string): string => rewriteExportImageSrc(rawSrc, {
    markdownFilePath: options.markdownFilePath,
    outputFilePath: options.outputFilePath,
    target: options.target,
    imageSearchRoots: options.imageSearchRoots,
    workspaceRootPath: options.workspaceRootPath,
    embeddedImageDataUrlCache
  });
  const deferImageSrc = (rawSrc: string): { src: string; deferredSrc?: string } => (
    options.contentOnly ? { src: '' } :
    github && !isGithubImageSource(rawSrc) ? { src: '' } :
    options.deferImages && (isLocalImageSrc(rawSrc) || /^(?:https?:)?\/\//i.test(rawSrc.trim()))
      ? { src: DEFERRED_IMAGE_PLACEHOLDER, deferredSrc: rawSrc }
      : { src: rewriteImageSrc(rawSrc) }
  );
  const originalSourceLines = String(options.markdownText ?? '').split(/\r?\n/);
  const normalized = { markdown: String(options.markdownText ?? ''), sourceLines: originalSourceLines.map((_, index) => index + 1) };
  const extractedFrontmatter = extractExportFrontmatter(normalized, uiStrings.properties);
  const shouldEnableMathTransform = extractedFrontmatter.body.markdown.includes('$')
    || latexDelimiters && /\\[([]/.test(extractedFrontmatter.body.markdown);

  const md = createMarkdownContentParser(github);
  if (github) installGithubInlineRules(md);
  const allowLocalLinks = !github || options.allowLocalLinks === true;
  const normalizeHref = (href: string) => options.deferLocalLinks || !allowLocalLinks
    ? normalizeLinkDestination(href) : rewriteExportLinkHref(href, options);
  const normalizeLink = md.normalizeLink.bind(md), validateLink = md.validateLink.bind(md);
  md.normalizeLink = href => normalizeLink(normalizeHref(href));
  md.validateLink = href => allowLocalLinks && isLocalFileLinkDestination(href) || validateLink(href);
  const githubHtml = github ? createGithubHtmlSanitizer(deferImageSrc, allowLocalLinks) : undefined;
  if (!github) {
    installWikiReferenceTransform(md, options.deferImages === true, options.wikiResources);
  }
  const resolveSourceRange = (startIndex: number, endIndex: number, environment?: { meoSourceLines?: readonly number[] }) => {
    const lines = environment?.meoSourceLines ?? bodySourceLines;
    return { start: lines?.[startIndex] ?? 0, end: lines?.[Math.max(startIndex, endIndex - 1)] ?? 0 };
  };
  const documentAnchors = installSourcePositionAndHeadingAnchorTransform(md, resolveSourceRange, (heading) => headings.push(heading), github, options.sourceFootnotes === true);
  installTableContainerTransform(md, (sourceLine) => (
    countLeadingIndentColumns(originalSourceLines[sourceLine - 1] ?? '')
  ));
  installTableCellSourceTransform(md);
  if (!github) installTableCellListTransform(md);
  installTaskListTransform(md, github);
  installKbdFallbackTransform(md);
  installAlertTransform(md, github ? type => type[0] + type.slice(1).toLowerCase() : uiStrings.alertLabel, github);
  installSafeHtmlTransform(
    md,
    deferImageSrc,
    resolveSourceRange,
    !github && options.showComments === true,
    !github,
    github ? generatedFootnoteTags : undefined,
    githubHtml?.sanitize
  );
  if (shouldEnableMathTransform) {
    installMathTransform(md, {
      latexDelimiters,
      githubStyle: github,
      deferDisplay: options.deferDisplayMath,
      output: options.contentOnly ? 'mathml' : 'html',
      onRenderedMath: () => {
        hasMath = true;
      }
    });
  }

  const defaultImageRule = md.renderer.rules.image ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  const imageSources = new WeakMap<object, string>();
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const imageNode = tokens[idx];
    if (options.contentOnly) return escapeHtml(imageNode.content || imageNode.attrGet('alt') || 'Image');
    const src = imageSources.get(imageNode) ?? imageNode.attrGet('src') ?? '';
    imageSources.set(imageNode, src);
    const rewritten = deferImageSrc(src);
    imageNode.attrSet('src', rewritten.src);
    if (rewritten.deferredSrc) imageNode.attrSet(DEFERRED_IMAGE_ATTRIBUTE, rewritten.deferredSrc);
    imageNode.attrSet('loading', 'eager');
    return defaultImageRule(tokens, idx, opts, env, self);
  };

  const renderCodeBlock: NonNullable<typeof md.renderer.rules.fence> = (tokens, idx, _opts, env) => {
    const codeBlock = tokens[idx];
    const language = codeBlock.type === 'fence' ? normalizeFenceLanguage(codeBlock.info) : '';
    const sourceLine = codeBlock.attrGet('data-source-line');
    const sourceEndLine = codeBlock.attrGet('data-source-end-line');
    const sourceAttrs = sourceLine
      ? ` data-source-line="${escapeHtmlAttr(sourceLine)}"${sourceEndLine ? ` data-source-end-line="${escapeHtmlAttr(sourceEndLine)}"` : ''}`
      : '';
    const source = String(codeBlock.content ?? '');
    const band = codeBlock.meta?.meoCodeBand as CodeBand | undefined;
    const richLanguage = github ? codeBlock.info.trim().split(/\s+/)[0] : language;
    const renderRichContent = !github || !env?.meoGithubFootnote;

    if (renderRichContent && (github ? richLanguage === 'math' : isMathFenceLanguage(language))) {
      const mathContent = mathFenceContent(source, latexDelimiters);
      const presentation = renderLatexMathPresentation(mathContent, 'display', options.deferDisplayMath, options.contentOnly ? 'mathml' : 'html');
      if (presentation) {
        hasMath = true;
        const copySource = source.replace(/\n$/, '');
        const body = mathFenceBodyRange(copySource, latexDelimiters);
        const sourceB64 = Buffer.from(copySource.slice(body.from, body.to), 'utf8').toString('base64');
        return `<div class="meo-export-math meo-export-math-display meo-export-math-fenced-display" data-source-b64="${sourceB64}"${presentation.attributes}${sourceAttrs}>${presentation.html}</div>`;
      }
    }

    if (options.contentOnly) return `<pre${sourceAttrs}><code>${escapeHtml(source.replace(/\n$/, ''))}</code></pre>`;
    if (renderRichContent && richLanguage === 'mermaid') {
      hasMermaid = true;
      const sourceB64 = Buffer.from(source, 'utf8').toString('base64');
      return [
        `<div class="meo-export-mermaid" data-source-b64="${escapeHtmlAttr(sourceB64)}"${sourceAttrs}>`,
        '<pre class="meo-export-code-block"><code class="language-mermaid">',
        escapeHtml(source),
        '</code></pre>',
        '</div>'
      ].join('');
    }

    // Interactive Preview owns viewport Shiki projection, including its full
    // screen-reader route. A whole-fence fallback tree duplicates that work.
    // Standalone HTML/PDF/Word continue to render their complete token HTML.
    const deferred = (options.windowedPresentation || options.deferCodeHighlight) && source.length >= 64_000 && viewportCodeLanguages.has(language) && !options.highlightCode;
    const highlighted = band || deferred
      ? escapeHtml(source)
      : options.highlightCode?.(source, language) ?? highlightFence(source, language);
    const compact = options.deferCodeHighlight === true && source.length >= 64_000 && !band && !github && !options.presetDefinition?.custom;
    const className = language ? ` class="hljs language-${escapeHtmlAttr(language)}"` : ' class="hljs"';
    const languageLabel = language && (!band || band.first)
      ? `<div class="meo-export-code-language-label">${escapeHtml(language)}</div>`
      : '';
    const exportAttributes = !github && codeBlock.type === 'fence' && options.exportBlockLanguages?.includes(language)
      ? ` data-meo-export-language="${escapeHtmlAttr(language)}" data-meo-export-source="${Buffer.from(source, 'utf8').toString('base64')}"` : '';
    const fenceStart = codeBlock.type === 'fence' && (!band || band.first);
    const contentLines = source ? source.split('\n').length - (source.endsWith('\n') ? 1 : 0) : 0;
    const fenceEnd = codeBlock.type === 'fence' && (band
      ? band.last && Number(sourceEndLine) > band.lines.at(-1)!
      : Boolean(codeBlock.map && codeBlock.map[1] - codeBlock.map[0] > contentLines + 1));
    return [
      `<div class="meo-export-code-block-wrap"${sourceAttrs}${exportAttributes}${fenceStart ? ' data-meo-code-fence-start="true"' : ''}${fenceEnd ? ' data-meo-code-fence-end="true"' : ''}${band ? ` data-meo-code-id="${band.id}" data-meo-code-offset="${band.offset}" data-meo-code-digits="${band.digits}" data-meo-code-part="${band.first ? 'start' : band.last ? 'end' : 'middle'}"` : ''}>`,
      languageLabel,
      `<pre class="meo-export-code-block"><code${className}${compact ? ` style="--meo-preview-code-digits:${Math.max(3, String(contentLines).length)}"` : ''}>${renderHighlightedCodeLines(highlighted, source, options.target, band, codeBlock.meta?.meoSourceLines, compact)}</code></pre>`,
      '</div>'
    ].join('');
  };
  md.renderer.rules.fence = renderCodeBlock;
  md.renderer.rules.code_block = renderCodeBlock;
  const footnoteAnchors = options.windowedPresentation ? [] as Array<{ id: string; sourceLine: number }> : undefined;
  const preparedMarkdown = prepareMarkdownWithFootnotes(extractedFrontmatter.body, {
    sourcePositions: options.sourceFootnotes,
    githubStyle: github,
    deferDefinitionPreparation: options.windowedPresentation === true,
    onFenceInfo: info => { hasMermaid ||= (github ? info.trim().split(/\s+/)[0] : normalizeFenceLanguage(info)) === 'mermaid'; },
    onReferenceTags: (tags: readonly string[]) => tags.forEach(tag => generatedFootnoteTags.add(tag)),
    onAnchor: footnoteAnchors ? (id, sourceLine) => footnoteAnchors.push({ id, sourceLine }) : undefined,
    target: options.target,
    outputFilePath: options.outputFilePath,
    renderMarkdown: (markdownText) => md.render(markdownText, github ? { meoGithubFootnote: true } : undefined),
    prepareMarkdown: (markdownText, sourceLines) => {
      const context = { meoFootnote: true, meoSourceLines: sourceLines, ...(github ? { meoGithubFootnote: true } : {}) };
      const nodes = md.parse(markdownText, context);
      if (!github) hasMermaid ||= nodes.some(node => node.type === 'fence' && normalizeFenceLanguage(node.info) === 'mermaid');
      return () => md.renderer.render(nodes, md.options, context);
    },
    normalizeMarkdown: github ? text => text : normalizeMarkdownForExportWithSourceMap,
    backToReference: uiStrings.backToReference,
    backToNumberedReference: uiStrings.backToNumberedReference,
    backToReferenceOccurrence: uiStrings.backToReferenceOccurrence
  });
  // Extract definitions before table normalization can change their four-space
  // continuation indent and accidentally detach subsequent blocks.
  const normalizedBody = github
    ? { markdown: preparedMarkdown.body.markdown, sourceLines: preparedMarkdown.body.markdown.split(/\r?\n/).map((_, index) => index + 1) }
    : normalizeMarkdownForExportWithSourceMap(preparedMarkdown.body.markdown, preparedMarkdown.bodyCodeLines);
  bodySourceLines = normalizedBody.sourceLines.map(line => preparedMarkdown.body.sourceLines[line - 1] ?? line);
  headings.length = 0;
  const environment = {};
  const deferredInline = options.windowedPresentation
    ? prepareDeferredMarkdownInline(md, normalizedBody.markdown, environment, documentAnchors, generatedFootnoteTags) : undefined;
  const bodyTokens = deferredInline?.tokens ?? md.parse(normalizedBody.markdown, environment);
  if (preparedMarkdown.sourceFootnotes) {
    for (const node of bodyTokens) {
      if (node.type !== 'html_block' || node.content.trim() !== sourceFootnoteMarker || !node.map) continue;
      const slot = preparedMarkdown.sourceFootnotes.get(bodySourceLines[node.map[0]]!);
      if (slot) node.meta = { ...node.meta, meoSourceFootnote: slot };
    }
    const renderHtml = md.renderer.rules.html_block!;
    md.renderer.rules.html_block = (nodes, index, ...args) => nodes[index]!.meta?.meoSourceFootnote?.render()
      ?? renderHtml(nodes, index, ...args);
  }
  const authorStyles = github ? '' : bodyTokens.filter(node => node.type === 'html_block')
    .map(node => inspectHtmlStylesheets(node.content).css).filter(Boolean).join('\n');
  hasMermaid ||= bodyTokens.some(node => node.type === 'fence'
    && (github ? node.info.trim().split(/\s+/)[0] : normalizeFenceLanguage(node.info)) === 'mermaid');
  const roots = markdownPresentationBlocks(bodyTokens, bodySourceLines,
    deferredInline ? index => deferredInline.prepareRange(index, index + 1) : undefined);
  const banded = options.windowedPresentation && !github && !options.presetDefinition?.custom;
  const codeBands = banded ? splitMarkdownCodeBands(bodyTokens, roots, bodySourceLines, syntaxToken => {
    const language = normalizeFenceLanguage(syntaxToken.info);
    return !language || viewportCodeLanguages.has(language) && language !== 'mermaid' && !isMathFenceLanguage(language) ? language : null;
  }) : { blocks: roots, sources: [] };
  const tokenBlocks = banded ? splitMarkdownContainerBands(bodyTokens,
    splitMarkdownTableBands(bodyTokens, codeBands.blocks, bodySourceLines), bodySourceLines) : roots;
  const documentHref = options.target === 'html' && options.outputFilePath
    ? `./${encodeURIComponent(path.basename(options.outputFilePath))}`
    : '';
  const tableOfContentsHtml = options.includeTableOfContents === true && headings.length > 0
    ? renderExportTableOfContents(
        headings,
        uiStrings.tableOfContents,
        uiStrings.untitledSection,
        documentHref
      )
    : '';
  const frontmatterHtml = github && extractedFrontmatter.frontmatterHtml && !extractedFrontmatter.frontmatterHtml.includes('meo-export-frontmatter-source')
      ? renderGithubFrontmatter(originalSourceLines, extractedFrontmatter.body.sourceLines[0] ?? originalSourceLines.length + 1)
      : extractedFrontmatter.frontmatterHtml;
  const sanitize = (rawHtml: string): RenderMarkdownResult => {
  const html = sanitizeHtml(github ? replaceGithubEmoji(linkifyGithubFilteredHtml(addGithubDetailsSummary(stripGithubSelectMarkup(rawHtml))), deferImageSrc) : rawHtml, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      ...(github ? [] : renderedHtmlTagNames),
      ...(github ? [...githubHtmlTags, 'input'] : []),
      'mark',
      'details',
      'summary',
      'img',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'th',
      'td',
      'pre',
      'code',
      'span',
      'div',
      'nav',
      'hr',
      'svg',
      'path',
      'circle',
      'line',
      'rect',
      'polygon',
      'polyline'
    ],
    allowedAttributes: renderedHtmlAttributes({
      ...(github ? { input: ['type', 'disabled', 'checked', 'aria-label'] } : {}),
      ...(github ? Object.fromEntries(Object.entries(githubHtmlAttributes).filter(([tag]) => !['*', 'a', 'img', 'ol', 'th', 'td', 'p', 'div', 'span', 'details'].includes(tag))) : {}),
      ...(github ? { source: ['srcset', 'data-meo-deferred-image-srcset'] } : {}),
      a: ['href', 'name', 'target', 'rel', 'title', 'aria-label'],
      details: ['open'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', DEFERRED_IMAGE_ATTRIBUTE, ...(github ? githubHtmlAttributes.img : [])],
      ol: ['start', 'reversed', ...(github ? githubHtmlAttributes.ol : [])],
      li: ['value'],
      '*': ['class', 'style', 'id', 'title', 'hidden', 'lang', 'dir', 'data-source-b64', 'data-meo-deferred-math', 'data-meo-container-part', 'data-meo-container-origin', 'data-meo-code-id', 'data-meo-code-digits', 'data-meo-code-offset', 'data-meo-code-part', 'data-meo-preview-table-widths', 'data-meo-preview-table-part', 'data-meo-preview-table-origin', 'data-source-line', 'data-source-end-line', 'data-meo-source-inline', 'data-meo-source-inline-end', 'data-meo-source-boundary', 'aria-hidden', ...(!github ? ['aria-*', 'data-*'] : githubHtmlAttributes['*'])],
      span: ['class', 'style', 'title', 'role', 'aria-label', 'aria-hidden', 'data-line-number'],
      th: ['colspan', 'rowspan', 'scope', 'style'],
      td: ['colspan', 'rowspan', 'style'],
      code: ['class'],
      p: ['align'],
      div: ['class', 'data-source-b64', 'data-meo-code-fence-start', 'data-meo-code-fence-end', 'align', ...(github ? githubHtmlAttributes.div : [])],
      nav: ['class', 'aria-label'],
      svg: [
        'xmlns',
        'width',
        'height',
        'viewbox',
        'viewBox',
        'preserveaspectratio',
        'preserveAspectRatio',
        'fill',
        'stroke',
        'stroke-width',
        'stroke-linecap',
        'stroke-linejoin',
        'stroke-miterlimit',
        'stroke-dasharray',
        'stroke-dashoffset',
        'stroke-opacity',
        'fill-rule',
        'fill-opacity'
      ],
      path: ['d'],
      circle: ['cx', 'cy', 'r'],
      line: ['x1', 'x2', 'y1', 'y2'],
      rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
      polygon: ['points'],
      polyline: ['points']
    }, github),
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'file', 'data', 'meo-wiki'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'file', 'data'],
      ...(github ? { srcset: ['http', 'https', 'file', 'data'] } : {})
    },
    allowProtocolRelative: github,
    ...(!github ? { parser: { lowerCaseTags: false, lowerCaseAttributeNames: false }, parseStyleAttributes: false } : {}),
    ...(github ? { nonTextTags: ['script', 'style', 'textarea', 'option', 'video'] } : {}),
    ...(github ? { exclusiveFilter: (frame: sanitizeHtml.IFrame) => frame.tag === 'a' && !frame.attribs.href && !frame.attribs.id && !frame.attribs.name ? 'excludeTag' as const : false } : {}),
    allowedStyles: github ? {
      img: { width: [/^\d+px$/], height: [/^\d+px$/] },
      '*': {
        ...htmlSanitizedStyleRules,
        '--meo-table-indent': [/^\d+(?:\.\d+)?ch$/i]
      },
      span: {
        position: [/^(?:static|relative|absolute)$/i],
        top: [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        left: [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        width: [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        height: [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        'min-width': [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        'margin-left': [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        'margin-right': [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        'padding-left': [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        'vertical-align': [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^baseline$/i, /^middle$/i],
        'border-bottom-width': [/^-?\d*\.?\d+(?:px|em|rem|%)?$/i, /^0$/],
        'background-color': [/^#[0-9a-f]{3,8}$/i],
        color: [/^[-#(),.%\w\s]+$/],
        'font-style': [/^(?:normal|italic)$/i],
        'font-weight': [/^(?:normal|bold)$/i],
        'text-decoration': [/^underline$/i]
      }
    } : undefined,
    transformTags: {
      ...(github ? { '*': (tagName: string, attribs: Record<string, string>) => ({
        tagName,
        attribs: /^(?:p|div|h[1-6]|ol|ul|blockquote)$/.test(tagName) && !attribs.dir ? { ...attribs, dir: 'auto' } : attribs
      }) } : {}),
      svg: (tagName, attribs) => {
        const viewBox = attribs.viewBox ?? attribs.viewbox;
        const preserveAspectRatio = attribs.preserveAspectRatio ?? attribs.preserveaspectratio;
        const normalizedAttributes = { ...attribs };
        delete normalizedAttributes.viewbox;
        delete normalizedAttributes.preserveaspectratio;
        return {
          tagName,
          attribs: {
            ...normalizedAttributes,
            ...(viewBox ? { viewBox } : {}),
            ...(preserveAspectRatio ? { preserveAspectRatio } : {})
          }
        };
      },
      a: (tagName, attribs) => {
        if (attribs.href) attribs.href = normalizeHref(attribs.href);
        if (github && attribs.href) {
          if (!isGithubLink(attribs.href, allowLocalLinks)) delete attribs.href;
          else if (attribs.href.startsWith('#')) {
            let anchor = attribs.href.slice(1);
            try { anchor = decodeURIComponent(anchor); } catch { /* Preserve malformed fragments. */ }
            if (githubHtml?.anchors.has(anchor) && !headings.some(heading => heading.id === anchor)) {
              attribs.href = `#user-content-${encodeURIComponent(anchor)}`;
            }
          }
        }
        const href = `${attribs.href ?? ''}`.trim();
        const next = { ...attribs };
        // The resource <base> points at a directory. HTML fragments must name
        // the exported file so authored links stay in the same document too.
        if (documentHref && href.startsWith('#')) next.href = `${documentHref}${href}`;
        if (/^https?:/i.test(href)) {
          next.target = '_blank';
          next.rel = 'noopener noreferrer';
        }
        return { tagName, attribs: next };
      }
    }
  });

  return { html, hasMermaid, hasMath };
  };
  const prefix = options.contentOnly ? '' : tableOfContentsHtml + frontmatterHtml;
  const prefixBlocks: MarkdownPresentationBlock[] = prefix ? [{ index: 0, sourceLine: 1,
    sourceEndLine: Math.max(1, (extractedFrontmatter.body.sourceLines[0] ?? 1) - 1),
    kind: 'frontmatter', sourceCharacters: prefix.length }] : [];
  const blocks: MarkdownPresentationBlock[] = [...prefixBlocks, ...tokenBlocks.map(block => ({
    index: block.index + prefixBlocks.length, sourceLine: block.sourceLine, sourceEndLine: block.sourceEndLine,
    kind: block.kind, sourceCharacters: block.sourceCharacters
  }))];
  const footnotes = options.sourceFootnotes ? [] : preparedMarkdown.footnotes;
  const splitFootnotes = options.windowedPresentation === true && footnotes.length > 1;
  if (splitFootnotes) for (const footnote of footnotes) {
    blocks.push({ index: blocks.length, sourceLine: footnote.sourceLine, sourceEndLine: footnote.sourceEndLine,
      kind: 'footnotes', sourceCharacters: footnote.sourceCharacters,
      sourceRanges: [{ start: footnote.sourceLine, end: footnote.sourceEndLine }] });
  }
  else if (footnotes.length) {
    const sourceRanges = footnotes.map(note => ({ start: note.sourceLine, end: note.sourceEndLine }));
    blocks.push({ index: blocks.length, sourceLine: originalSourceLines.length, sourceEndLine: originalSourceLines.length,
      kind: 'footnotes', sourceCharacters: footnotes.reduce((sum, note) => sum + note.sourceCharacters, 0), sourceRanges });
  }
  return {
    authorStyles,
    blocks,
    hasMermaid,
    headings: headings.map(heading => ({ ...heading })),
    codeSources: codeBands.sources,
    anchors: footnoteAnchors ?? [],
    renderBlock(index) {
      if (!Number.isInteger(index) || index < 0 || index >= blocks.length) throw new RangeError('Unknown Markdown presentation block');
      if (prefixBlocks.length && index === 0) return sanitize(prefix);
      const block = tokenBlocks[index - prefixBlocks.length];
      if (block) deferredInline?.prepareRange(block.from, block.to);
      if (block && isMarkdownTableBand(block) && block.table.first) deferredInline?.prepareRange(block.table.open, block.table.headEnd);
      const footerIndex = index - prefixBlocks.length - tokenBlocks.length;
      if (!block && splitFootnotes) {
        const note = footnotes[footerIndex]!;
        return sanitize(`<section class="footnotes${footerIndex ? ' meo-preview-footnotes-continuation' : ''}" data-source-line="${note.sourceLine}" data-source-end-line="${note.sourceEndLine}">`
          + `<ol class="footnotes-list" start="${footerIndex + 1}">${note.render()}</ol></section>`);
      }
      return sanitize(block
        ? md.renderer.render(isMarkdownContainerBand(block) ? renderContainerBandTokens(bodyTokens, block) : isMarkdownCodeBand(block) ? renderCodeBandToken(bodyTokens, block) : isMarkdownTableBand(block) ? renderTableBandTokens(bodyTokens, block) : bodyTokens.slice(block.from, block.to), md.options, environment)
        : preparedMarkdown.footnotesHtml);
    },
    renderAll: () => {
      deferredInline?.prepareAll();
      const rendered = sanitize(prefix + md.renderer.render(bodyTokens, md.options, environment)
        + (options.sourceFootnotes ? '' : preparedMarkdown.footnotesHtml));
      return authorStyles && !options.contentOnly ? { ...rendered, html: `<style>${authorStyles}</style>${rendered.html}` } : rendered;
    }
  };
}

function renderHighlightedCodeLines(highlighted: string, source: string, target: RenderMarkdownOptions['target'], band?: CodeBand, mappedSourceLines?: readonly number[], compact = false): string {
  const rows: string[] = [];
  const openSpans: string[] = [];
  let rowHtml = '';
  let cursor = 0;

  while (cursor < highlighted.length) {
    if (highlighted[cursor] === '\n') {
      rowHtml += '</span>'.repeat(openSpans.length);
      rows.push(rowHtml);
      rowHtml = openSpans.join('');
      cursor += 1;
      continue;
    }

    if (highlighted.startsWith('</span>', cursor)) {
      openSpans.pop();
      rowHtml += '</span>';
      cursor += '</span>'.length;
      continue;
    }

    if (highlighted.startsWith('<span', cursor)) {
      const tagEnd = highlighted.indexOf('>', cursor);
      if (tagEnd >= 0) {
        const openingTag = highlighted.slice(cursor, tagEnd + 1);
        openSpans.push(openingTag);
        rowHtml += openingTag;
        cursor = tagEnd + 1;
        continue;
      }
    }

    rowHtml += highlighted[cursor];
    cursor += 1;
  }

  if (rows.length === 0 || !source.endsWith('\n')) {
    rowHtml += '</span>'.repeat(openSpans.length);
    rows.push(rowHtml);
  }

  // Browser grid rows need selectable breaks; Word normalization supplies its own.
  const sourceLines = source.split('\n');
  return rows.map((row, index) => compact
    ? `<span class="meo-export-code-line meo-export-code-line-source meo-preview-code-line" data-line-number="${index + 1}"${mappedSourceLines?.[index] ? ` data-source-line="${mappedSourceLines[index]}"` : ''}>${row}${source.length > 0 && sourceLines[index] === '' ? '<br>' : ''}</span>`
    : [
    '<span class="meo-export-code-line">',
    `<span class="meo-export-code-line-number" aria-hidden="true" data-line-number="${(band?.offset ?? 0) + index + 1}"></span>`,
    `<span class="meo-export-code-line-source"${(band?.lines ?? mappedSourceLines)?.[index] ? ` data-source-line="${(band?.lines ?? mappedSourceLines)![index]}"` : ''}>${row}${target !== 'docx' && source.length > 0 && sourceLines[index] === '' ? '<br>' : ''}</span>`,
    '</span>'
  ].join('')).join(band ? '\n' : '') + (source.endsWith('\n') ? '\n' : '');
}

function installSafeHtmlTransform(
  md: MarkdownIt,
  rewriteImageSrc: (rawSrc: string) => { src: string; deferredSrc?: string },
  resolveSourceRange: (startIndex: number, endIndex: number, environment?: any) => { start: number; end: number },
  showComments: boolean,
  preserveSourceStyles = true,
  generatedFootnoteTags?: ReadonlySet<string>,
  githubSanitize?: (source: string) => string
): void {
  const allowedAttributes = Object.fromEntries(
    renderedHtmlTagNames.map((tagName) => [tagName, getSupportedHtmlAttributes(tagName)
      .filter(attribute => preserveSourceStyles || !['style', 'class', 'id'].includes(attribute))])
  );
  allowedAttributes.img = [...allowedAttributes.img, DEFERRED_IMAGE_ATTRIBUTE];
  const safeHtmlSanitizerOptions: NonNullable<Parameters<typeof sanitizeHtml>[1]> = {
    allowedTags: renderedHtmlTagNames,
    allowedAttributes,
    disallowedTagsMode: 'escape',
    nonTextTags: [],
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'file', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'file', 'data']
    },
    allowProtocolRelative: false,
    transformTags: {
      '*': (tagName, attribs) => {
        const attributes: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) {
          const normalized = normalizeHtmlAttribute(tagName, name, value);
          if (normalized !== null) attributes[canonicalHtmlAttributeName(name)] = normalized;
        }
        if (attributes.hidden === '') attributes.hidden = 'hidden';
        if ('style' in attributes) {
          const style = sanitizeHtmlStyle(attributes.style);
          if (style) attributes.style = style;
          else delete attributes.style;
        }
        if (tagName.toLowerCase() === 'a' && attributes.href) attributes.href = normalizeLinkDestination(attributes.href);
        if (attributes.srcset) {
          const raw = attributes.srcset;
          const rewritten = mapHtmlSrcset(raw, url => rewriteImageSrc(url).src);
          if (mapHtmlSrcset(raw, url => rewriteImageSrc(url).deferredSrc ?? '').length) {
            attributes['data-meo-html-srcset'] = raw;
            delete attributes.srcset;
          } else attributes.srcset = rewritten;
        }
        for (const name of ['src', 'poster']) if (attributes[name]) {
          const rewritten = rewriteImageSrc(attributes[name]!);
          if (rewritten.deferredSrc) {
            const ordinaryImage = tagName.toLowerCase() === 'img' && name === 'src' && !attributes['data-meo-html-srcset'];
            attributes[ordinaryImage ? DEFERRED_IMAGE_ATTRIBUTE : `data-meo-html-${name}`] = rewritten.deferredSrc;
            if (ordinaryImage) attributes[name] = rewritten.src; else delete attributes[name];
          } else attributes[name] = rewritten.src;
        }
        return { tagName: canonicalHtmlTagName(tagName), attribs: attributes };
      }
    }
  };
  const sanitizeRawSource = (source: string, tokenType: string): string => {
    source = inspectHtmlStylesheets(source).html;
    if (!source.trim()) return '';
    if (isSupportedHtmlSource(source) && getHtmlTagNames(source).some(tag => !supportedHtmlTags.has(tag))) {
      return sanitizeHtml(source, safeHtmlSanitizerOptions);
    }
    if (tokenType === 'html_block' && isSupportedHtmlSource(source)) {
      // A GFM HTML container can span multiple Markdown tokens. Sanitizing each
      // block as a balanced document closes <details> before its Markdown body.
      let fragment = '';
      let cursor = 0;
      const append = (html: string) => {
        // The parser ignores unmatched closing tags from preceding Markdown
        // tokens. Retain those gaps; opening tags always go through sanitization.
        fragment += source.slice(cursor, parser.startIndex) + html;
        cursor = parser.endIndex + 1;
      };
      const parser = new Parser({
        onopentag: (_name, _attributes, implied) => { if (!implied) append(sanitizeRawSource(source.slice(parser.startIndex, parser.endIndex + 1), 'html_inline')); },
        onclosetag: (name, implied) => { if (!implied) append(`</${canonicalHtmlTagName(name)}>`); },
        ontext: append,
        oncomment: () => append(''),
        onprocessinginstruction: () => append(''),
        onend: () => { fragment += source.slice(cursor); }
      }, { decodeEntities: false });
      parser.end(source);
      return fragment;
    }
    if (source.includes('<!--')) {
      const comments: Array<{ from: number; to: number; raw: string }> = [];
      const visit = (nodes: readonly ChildNode[]): void => {
        for (const node of nodes) {
          if (node.type === 'comment' && node.startIndex !== null && node.endIndex !== null) {
            const raw = source.slice(node.startIndex, node.endIndex + 1);
            if (/^<!--[\s\S]*?-->$/.test(raw)) comments.push({ from: node.startIndex, to: node.endIndex + 1, raw });
          }
          if ('children' in node) visit(node.children);
        }
      };
      visit(parseDocument(source, { withStartIndices: true, withEndIndices: true }).children);
      if (comments.length) {
        let markerPrefix = 'MEOHTMLCOMMENTTOKEN';
        while (source.includes(markerPrefix)) markerPrefix += 'X';
        const onlyComment = comments.length === 1 && source.trim() === comments[0].raw;
        let cursor = 0;
        let policySource = '';
        let renderSource = '';
        const replacements: Array<{ marker: string; html: string }> = [];
        for (const [index, comment] of comments.entries()) {
          const before = source.slice(cursor, comment.from);
          policySource += before;
          renderSource += before;
          if (showComments) {
            const marker = `${markerPrefix}${index}END`;
            const content = escapeHtml(comment.raw);
            const block = onlyComment && tokenType === 'html_block';
            replacements.push({ marker, html: block
              ? `<aside class="meo-export-comment" role="note">${content}</aside>`
              : `<span class="meo-export-comment meo-export-comment-inline" role="note">${content}</span>` });
            renderSource += marker;
          }
          cursor = comment.to;
        }
        policySource += source.slice(cursor);
        renderSource += source.slice(cursor);
        const rendered = isSupportedHtmlSource(policySource)
          ? (preserveSourceStyles ? sanitizeHtml(renderSource, safeHtmlSanitizerOptions) : sanitizeRawSource(renderSource, tokenType))
          : escapeHtml(renderSource);
        return replacements.reduce((html, replacement) => html.replace(replacement.marker, replacement.html), rendered);
      }
    }
    if (!isSupportedHtmlSource(source)) return escapeHtml(source);
    if (tokenType !== 'html_inline') return sanitizeHtml(source, safeHtmlSanitizerOptions);

    const trimmed = source.trim();
    const closingTag = /^<\/\s*([a-z][a-z\d-]*)\s*>$/i.exec(trimmed);
    if (closingTag) return `</${canonicalHtmlTagName(closingTag[1]!)}>`;

    const openingTag = /^<\s*([a-z][a-z\d-]*)\b[^>]*>$/i.exec(trimmed);
    if (!openingTag || /<\/\s*[a-z]/i.test(trimmed)) {
      return sanitizeHtml(source, safeHtmlSanitizerOptions);
    }
    const tagName = openingTag[1].toLowerCase();
    if (tagName === 'br' || tagName === 'img' || /\/\s*>$/.test(trimmed)) {
      return sanitizeHtml(source, safeHtmlSanitizerOptions);
    }
    const sanitizedPair = sanitizeHtml(`${source}</${tagName}>`, safeHtmlSanitizerOptions);
    return new RegExp(`^<${tagName}\\b[^>]*>`, 'i').exec(sanitizedPair)?.[0] ?? escapeHtml(source);
  };
  const renderRawHtml = (tokens: any[], index: number, _options: unknown, environment: any): string => {
    const htmlNode = tokens[index];
    const source = String(htmlNode?.content ?? '');
    if (htmlNode?.meta?.meoTrustedHtml === true || generatedFootnoteTags?.has(source)) return source;
    let rendered = githubSanitize ? githubSanitize(source) : sanitizeRawSource(source, String(htmlNode?.type ?? ''));
    // Inline author HTML has no block wrapper. Mark its sanitized root so the
    // reading layout can apply the same native box rules as Live HTML content.
    if (!githubSanitize && preserveSourceStyles && htmlNode?.type === 'html_inline'
      && supportedHtmlTags.has(getHtmlRootTagName(source) ?? '')) {
      rendered = rendered.replace(/^(\s*<[a-z][a-z\d-]*)(?=[\s>])/i, '$1 data-meo-html-content=""');
    }
    if (githubSanitize && Array.isArray(htmlNode.meta?.meoGithubHeadingIds)) {
      let headingIndex = 0;
      rendered = rendered.replace(/<h[1-6]\b[^>]*>/gi, (opening) => {
        const id = htmlNode.meta.meoGithubHeadingIds[headingIndex++];
        if (!id) return opening;
        return /\bid=/.test(opening)
          ? `${opening}<a id="${escapeHtmlAttr(id)}"></a>`
          : opening.replace(/>$/, ` id="${escapeHtmlAttr(id)}">`);
      });
    }
    if (rendered === '') return '';
    if (htmlNode?.type !== 'html_block' || !Array.isArray(htmlNode.map)) return rendered;
    const sourceRange = resolveSourceRange(Number(htmlNode.map[0]), Number(htmlNode.map[1]), environment);
    if (sourceRange.start <= 0) return rendered;
    const fragments = splitHtmlBlockFragments(source);
    const withoutComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim();
    const complete = /^\s*<!--/.test(source) && !withoutComments(source)
      || fragments.length > 0 && !/<\/?[a-z]/i.test(withoutComments(source.slice(fragments.at(-1)!.to)))
        && !withoutComments(source.slice(0, fragments[0].from));
    if (/^\s*<\/details\s*>\s*$/i.test(rendered)) {
      return `<span hidden data-source-line="${sourceRange.start}" data-source-end-line="${sourceRange.end}" data-meo-source-boundary="true"></span>${rendered}`;
    }
    if (!preserveSourceStyles || !complete) {
      return rendered.replace(/^(\s*<[a-z][a-z\d-]*)(?=[\s>])/i, `$1 data-source-line="${sourceRange.start}" data-source-end-line="${Math.max(sourceRange.start, sourceRange.end)}"`);
    }
    return `<div class="meo-export-html-block" data-source-line="${sourceRange.start}" data-source-end-line="${Math.max(sourceRange.start, sourceRange.end)}">${rendered}</div>`;
  };
  md.renderer.rules.html_block = renderRawHtml;
  md.renderer.rules.html_inline = renderRawHtml;
}

function installSourcePositionAndHeadingAnchorTransform(
  md: MarkdownIt,
  resolveSourceRange: (startIndex: number, endIndex: number, environment?: any) => { start: number; end: number },
  onHeading?: (heading: ExportHeading) => void,
  github = false,
  preciseSourcePositions = false
): (state: Parameters<MarkdownIt['core']['process']>[0]) => void {
  const assignAnchors = (state: any) => {
    if (state.env?.meoTableCell) return;
    const slugCounts = new Map<string, number>();
    const tokens = state.tokens as any[];
    const githubId = (text: string) => {
      const base = text.trim().toLowerCase().replace(/<[^>]*>/g, '')
        .replace(/[^\p{Letter}\p{Number}\p{Mark} _-]/gu, '').replace(/ /g, '-');
      let id = base, suffix = slugCounts.get(base) ?? 0;
      while (slugCounts.has(id)) id = `${base}-${++suffix}`;
      slugCounts.set(base, suffix);
      slugCounts.set(id, 0);
      return id;
    };

    for (let index = 0; index < tokens.length; index += 1) {
      const headingOpen = tokens[index];
      const sourceRange = (!state.env?.meoFootnote || preciseSourcePositions) && Array.isArray(headingOpen.map)
        ? resolveSourceRange(Number(headingOpen.map[0]), Number(headingOpen.map[1]), state.env)
        : null;
      const sourceLine = sourceRange?.start ?? 0;
      const sourceEndLine = sourceRange?.end ?? 0;
      if (github && headingOpen.type === 'html_block') {
        const ids: string[] = [];
        for (const match of String(headingOpen.content).matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
          let text = '';
          new Parser({ ontext: part => { text += part; } }).end(match[2]);
          const id = githubId(text);
          ids.push(id);
          if (!state.env?.meoFootnote) onHeading?.({ level: Number(match[1]), id, text, line: sourceLine });
        }
        if (ids.length) headingOpen.meta = { ...headingOpen.meta, meoGithubHeadingIds: ids };
      }
      if ((headingOpen.nesting === 1 || ['fence', 'code_block', 'meo_math_block', 'hr'].includes(headingOpen.type)) && sourceLine > 0) {
        headingOpen.attrSet('data-source-line', String(sourceLine));
        headingOpen.attrSet('data-source-end-line', String(Math.max(sourceLine, sourceEndLine)));
      }
      if (preciseSourcePositions && sourceLine > 0 && ['inline', 'fence', 'code_block'].includes(headingOpen.type)) {
        const first = Number(headingOpen.map[0]) + (headingOpen.type === 'fence' ? 1 : 0);
        const length = headingOpen.type === 'inline' ? Number(headingOpen.map[1]) - first
          : String(headingOpen.content).replace(/\n$/, '').split('\n').length;
        if (headingOpen.type !== 'inline' || length > 1 || tokens[index - 1]?.hidden) {
          headingOpen.meta = { ...headingOpen.meta, meoSourceLines: Array.from({ length }, (_, offset) => resolveSourceRange(first + offset, first + offset + 1, state.env).start) };
        }
      }
      if (headingOpen.type !== 'heading_open') {
        continue;
      }

      const inlineContent = tokens[index + 1];
      const headingSource = github ? extractHeadingText(inlineContent, true) : String(inlineContent?.content ?? '');
      // GitHub preserves each space and existing hyphen, including gaps left by punctuation.
      const baseSlug = github
        ? headingSource.trim().toLowerCase().replace(/<[^>]*>/g, '')
          .replace(/[^\p{Letter}\p{Number}\p{Mark} _-]/gu, '').replace(/ /g, '-')
        : markdownHeadingAnchor(headingSource);
      let id = baseSlug;
      if (github) {
        id = githubId(headingSource);
      } else {
        const occurrence = (slugCounts.get(baseSlug) ?? 0) + 1;
        slugCounts.set(baseSlug, occurrence);
        id = occurrence === 1 ? baseSlug : `${baseSlug}-${occurrence}`;
      }
      headingOpen.attrSet('id', id);
      if (!state.env?.meoFootnote) onHeading?.({
        level: Number.parseInt(String(headingOpen.tag).slice(1), 10),
        id,
        text: extractHeadingText(inlineContent),
        line: sourceLine
      });

    }
  };
  md.core.ruler.after('inline', 'meo-heading-anchors', assignAnchors);
  if (!preciseSourcePositions) return assignAnchors;
  // Empty inline boundaries preserve the original formatting tree and native
  // selection, including emphasis crossing a source newline and tight lists
  // whose paragraph tags are intentionally omitted. Geometry uses DOM Ranges.
  md.renderer.rules.meo_source_position = (tokens, index) => tokens[index]!.content;
  const inlineSources = new WeakMap<object, readonly number[]>();
  const render = md.renderer.render;
  md.renderer.render = function(tokens, options, environment) {
    for (const node of tokens) {
      if (node.type === 'inline' && node.children && node.meta?.meoSourceLines) inlineSources.set(node.children, node.meta.meoSourceLines);
    }
    return render.call(this, tokens, options, environment);
  };
  const renderInline = md.renderer.renderInline;
  md.renderer.renderInline = function(children, options, environment) {
    const lines = inlineSources.get(children);
    if (lines?.length && children.length) {
      const boundary = (line?: number, endLine = line) => {
        const boundaryNode = new (children[0]!.constructor as any)('meo_source_position', '', 0);
        boundaryNode.content = line === undefined ? '<span data-meo-source-inline-end="true"></span>'
          : `<span data-source-line="${line}" data-source-end-line="${endLine}" data-meo-source-inline="true"></span>`;
        return boundaryNode;
      };
      // Multiline literals can collapse their source newlines into one inline
      // result. Keep that result atomic instead of inventing an offset mapping.
      const split = children.filter(child => child.type === 'softbreak' || child.type === 'hardbreak').length + 1 === lines.length;
      const mapped = [boundary(lines[0], split ? lines[0] : lines.at(-1))];
      let lineIndex = 0;
      for (const child of children) {
        if (split && (child.type === 'softbreak' || child.type === 'hardbreak')) {
          mapped.push(boundary(), child, boundary(lines[++lineIndex]));
        } else mapped.push(child);
      }
      mapped.push(boundary());
      return renderInline.call(this, mapped, options, environment);
    }
    return renderInline.call(this, children, options, environment);
  };
  return assignAnchors;
}

function installTableContainerTransform(md: MarkdownIt, resolveIndent: (sourceLine: number) => number): void {
  const defaultTableOpen = md.renderer.rules.table_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose = md.renderer.rules.table_close ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
    const sourceLine = Number(tokens[idx]?.attrGet('data-source-line') ?? 0);
    const indent = !env?.meoFootnote && tokens[idx]?.level === 0 && sourceLine > 0 ? resolveIndent(sourceLine) : 0;
    const wrapperAttributes = indent > 0
      ? ` class="meo-table-scroll meo-export-indented-table" style="--meo-table-indent:${indent}ch"`
      : ' class="meo-table-scroll"';
    const bandSource = tokens[idx]?.attrGet('data-meo-preview-table-part')
      ? ` data-source-line="${sourceLine}" data-source-end-line="${tokens[idx]!.attrGet('data-source-end-line')}"` : '';
    return `<div${wrapperAttributes}${bandSource}>${defaultTableOpen(tokens, idx, options, env, self)}`;
  };
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => (
    `${defaultTableClose(tokens, idx, options, env, self)}</div>`
  );
}

function installTableCellSourceTransform(md: MarkdownIt): void {
  // Use the resolved table rows, so pipe handling never rewrites adjacent blocks.
  // The bundled table rule removes an escape after any slash run; cells must
  // instead share Live's GFM boundaries before their inline contents are parsed.
  md.core.ruler.after('block', 'meo_table_cell_source', (state) => {
    const lines = state.src.split('\n');
    let cells: string[] = [];
    let column = 0;
    for (let index = 0; index < state.tokens.length; index += 1) {
      const node = state.tokens[index];
      if (node.type === 'tr_open' && node.map) {
        cells = splitMarkdownTableRow(lines[node.map[0]] ?? '');
        column = 0;
      } else if (node.type === 'inline' && state.tokens[index - 1]?.type === 'td_open') {
        node.content = (cells[column++] ?? '').replace(/\\\|/g, '|');
      }
    }
  });
}

function installTableCellListTransform(md: MarkdownIt): void {
  // A cell's explicit breaks delimit logical lines. Restrict these extensions
  // to cells; normal prose retains Markdown's ordered-list and lazy-quote rules.
  md.block.ruler.before('list', 'meo_cell_ordered_boundary', (state, line, _end, silent) => (
    Boolean(silent && state.env?.meoTableCell
      && /^\d{1,9}[.)][ \t]+/.test(state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])))
  ), { alt: ['paragraph', 'blockquote'] });
  md.block.ruler.before('blockquote', 'meo_cell_quote_boundary', (state, _line, _end, silent) => (
    Boolean(silent && state.env?.meoTableCell && state.parentType === 'blockquote')
  ), { alt: ['blockquote'] });
  md.core.ruler.after('inline', 'meo_table_cell_lists', (state) => {
    for (let index = 1; index < state.tokens.length; index += 1) {
      const inlineNode = state.tokens[index];
      const parentType = state.tokens[index - 1]?.type;
      if (inlineNode.type !== 'inline' || (parentType !== 'td_open' && parentType !== 'th_open')) {
        continue;
      }
      const renderedList = renderBreakSeparatedCellList(inlineNode.content, md);
      if (!renderedList) {
        continue;
      }
      const htmlNode = new state.Token('html_inline', '', 0);
      htmlNode.content = renderedList;
      htmlNode.meta = { ...(htmlNode.meta ?? {}), meoTrustedHtml: true };
      inlineNode.children = [htmlNode];
    }
  });
}

function renderBreakSeparatedCellList(content: string, md: MarkdownIt): string | null {
  // A single ordinary cell cannot contain a block list. Keep the parser-owned
  // splitter for actual breaks and leading list/quote candidates, including
  // literal break text inside code or links.
  if (!/[\r\n]|<br\b/i.test(content) && !/^[ \t]*(?:>|[-+*]\s|\d+[.)]\s)/.test(content)) return null;
  const lines = splitCellLogicalLines(content, md);
  if (!lines.some((line) => /^[ \t]*(?:>|[-+*]\s|\d+[.)]\s)/.test(line))) return null;
  // Use the document parser so quotes, nested lists, task states and inline
  // styles share their normal semantics inside break-separated cells.
  return md.render(lines.join('\n'), { meoTableCell: true });
}


function splitCellLogicalLines(content: string, md: MarkdownIt): string[] {
  const state = new md.inline.State(content, md, {}, []);
  const lines: string[] = [];
  let start = 0;
  while (state.pos < state.posMax) {
    const match = /^(?:<br\s*\/?\s*>|\r?\n)/i.exec(content.slice(state.pos));
    if (match) {
      lines.push(content.slice(start, state.pos));
      state.pos += match[0].length;
      start = state.pos;
    } else {
      // The inline parser skips complete code spans, links and escapes, so a
      // literal <br> within them never becomes structural Markdown.
      md.inline.skipToken(state);
    }
  }
  lines.push(content.slice(start));
  return lines;
}

function extractHeadingText(inlineToken: any, github = false): string {
  const collect = (tokens: any[]): string => tokens.map((token) => {
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'image') {
      return String(token.content ?? '');
    }
    if (github && token.type === 'text_special') return String(token.content ?? '');
    if (github && token.meta?.meoMathSource) return String(token.meta.meoMathSource);
    return Array.isArray(token.children) ? collect(token.children) : '';
  }).join('');
  const text = collect(Array.isArray(inlineToken?.children) ? inlineToken.children : []);
  return (github ? text : text.replace(/\s+/g, ' ')).trim();
}

function renderExportTableOfContents(
  headings: readonly ExportHeading[],
  title: string,
  untitledSection: string,
  documentHref: string
): string {
  type TocNode = ExportHeading & { children: TocNode[] };
  const root: TocNode = { level: 0, id: '', text: '', line: 0, children: [] };
  const stack: TocNode[] = [root];

  for (const heading of headings) {
    while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    const node: TocNode = { ...heading, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  const renderList = (items: readonly TocNode[]): string => [
    '<ul class="meo-export-toc-list">',
    ...items.map((item) => [
      '<li class="meo-export-toc-item">',
      `<a class="meo-export-toc-link" href="${escapeHtmlAttr(documentHref)}#${escapeHtmlAttr(
        documentHref ? encodeURIComponent(item.id) : item.id
      )}">${escapeHtml(item.text || untitledSection)}</a>`,
      item.children.length > 0 ? renderList(item.children) : '',
      '</li>'
    ].join('')),
    '</ul>'
  ].join('');

  return [
    `<nav class="meo-export-toc" aria-label="${escapeHtmlAttr(title)}">`,
    `<h2 class="meo-export-toc-title">${escapeHtml(title)}</h2>`,
    renderList(root.children),
    '</nav>'
  ].join('');
}

function normalizeMarkdownForExport(markdownText: string): string {
  return normalizeMarkdownForExportWithSourceMap(markdownText).markdown;
}

function normalizeMarkdownForExportWithSourceMap(markdownText: string, knownCodeLines?: ReadonlySet<number>): SourceMappedMarkdown {
  const codeLines = knownCodeLines ?? collectMarkdownCodeLines(markdownText);
  const normalized = normalizeLooseTableDelimiters(markdownText, codeLines);
  const expandedLists = expandBreakSeparatedBodyLists(normalized, codeLines);
  return ensureBlankLinesAroundTableBlocks(expandedLists.markdown, expandedLists.sourceLines, codeLines);
}

function expandBreakSeparatedBodyLists(markdownText: string, codeLines: ReadonlySet<number>): { markdown: string; sourceLines: number[] } {
  const lines = String(markdownText ?? '').split(/\r?\n/);
  const out: string[] = [];
  const sourceLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const expanded = !codeLines.has(index) && !line.includes('|')
      ? expandBodyListBreaks(line)
      : [line];
    for (const expandedLine of expanded) {
      out.push(expandedLine);
      sourceLines.push(index + 1);
    }
  }
  return { markdown: out.join('\n'), sourceLines };
}

function normalizeLooseTableDelimiters(markdownText: string, codeLines: ReadonlySet<number>): string {
  const lines = String(markdownText ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (codeLines.has(index) || index === 0) continue;
    const originalDelimiter = lines[index] ?? '';
    const containerPrefix = /^[ \t]*(?:>[ \t]*)*/.exec(originalDelimiter)?.[0] ?? '';
    const delimiter = originalDelimiter.slice(containerPrefix.length);
    if (!canRepairMarkdownTableDelimiter(delimiter) || !isTableHeaderLine(lines[index - 1] ?? '')) {
      continue;
    }
    // Keep even-run header pipes visible to the bundled table rule. Its cell
    // trimming removes this separator padding; source line mapping is unchanged.
    lines[index - 1] = lines[index - 1].replace(/(\\+)\|/g, (match, slashes: string) => (
      slashes.length % 2 === 0 ? `${slashes} |` : match
    ));
    const headerColumnCount = countTableCells((lines[index - 1] ?? '').replace(/^[ \t]*(?:>[ \t]*)*/, ''));
    const delimiterCells = splitTableCells(delimiter);
    if (headerColumnCount <= delimiterCells.length) {
      continue;
    }
    const leadingPipe = delimiter.trimStart().startsWith('|');
    const trailingPipe = delimiter.trimEnd().endsWith('|');
    while (delimiterCells.length < headerColumnCount) {
      delimiterCells.push('---');
    }
    lines[index] = `${containerPrefix}${leadingPipe ? '| ' : ''}${delimiterCells.join(' | ')}${trailingPipe ? ' |' : ''}`;
  }
  return lines.join('\n');
}

function countTableCells(line: string): number {
  return splitTableCells(line).length;
}

function splitTableCells(line: string): string[] {
  return splitMarkdownTableRow(line);
}

function countLeadingIndentColumns(line: string): number {
  const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? '';
  return [...leadingWhitespace].reduce((columns, character) => (
    character === '\t' ? columns + 4 - (columns % 4) : columns + 1
  ), 0);
}

function ensureBlankLinesAroundTableBlocks(
  markdownText: string,
  inputSourceLines: number[],
  codeLines: ReadonlySet<number>
): { markdown: string; sourceLines: number[] } {
  const lines = String(markdownText ?? '').split(/\r?\n/);
  const out: string[] = [];
  const sourceLines: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (codeLines.has((inputSourceLines[i] ?? i + 1) - 1)) {
      out.push(line);
      sourceLines.push(inputSourceLines[i] ?? i + 1);
      continue;
    }

    if (!isTableHeaderLine(line) || !isTableDelimiterLine(lines[i + 1] ?? '')) {
      out.push(line);
      sourceLines.push(inputSourceLines[i] ?? i + 1);
      continue;
    }

    if (out.length > 0 && out[out.length - 1].trim() !== '') {
      out.push('');
      sourceLines.push(inputSourceLines[i] ?? i + 1);
    }

    const tableIndent = line.match(/^[ \t]*/)?.[0] ?? '';
    const tableIndentColumns = countLeadingIndentColumns(line);
    const keepParserIndent = tableIndentColumns <= 3 || isTableNestedUnderList(lines, i, tableIndentColumns);
    const normalizeTableLine = (tableLine: string): string => (
      !tableIndent
        ? tableLine
        : keepParserIndent
          ? `${tableIndent}${tableLine.trimStart()}`
          : tableLine.trimStart()
    );

    out.push(normalizeTableLine(line));
    sourceLines.push(inputSourceLines[i] ?? i + 1);
    i += 1;
    out.push(normalizeTableLine(lines[i] ?? ''));
    sourceLines.push(inputSourceLines[i] ?? i + 1);

    while (i + 1 < lines.length && isTableRowLine(lines[i + 1] ?? '')) {
      i += 1;
      out.push(normalizeTableLine(lines[i] ?? ''));
      sourceLines.push(inputSourceLines[i] ?? i + 1);
    }

    if (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== '') {
      out.push('');
      sourceLines.push(inputSourceLines[i + 1] ?? i + 2);
    }
  }

  return { markdown: out.join('\n'), sourceLines };
}

function isTableNestedUnderList(lines: string[], tableLineIndex: number, tableIndentColumns: number): boolean {
  for (let index = tableLineIndex - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      continue;
    }
    const listMarker = /^(?<indent>[ \t]*)(?<marker>[-+*]|\d+[.)])\s+/.exec(line);
    if (listMarker?.groups) {
      const contentIndent = countLeadingIndentColumns(listMarker.groups.indent)
        + listMarker.groups.marker.length
        + 1;
      return tableIndentColumns >= contentIndent;
    }
    if (countLeadingIndentColumns(line) === 0) {
      return false;
    }
  }
  return false;
}

function isTableHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed !== '|';
}

function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.includes('|');
}

function isTableDelimiterLine(line: string): boolean {
  return canRepairMarkdownTableDelimiter(line);
}

const bodyInlineParser = createMarkdownContentParser();

function expandBodyListBreaks(line: string): string[] {
  if (!/<br/i.test(line)) return [line];
  // Keep ordinary HTML breaks intact; only the supported list extension expands.
  const state = new bodyInlineParser.inline.State(line, bodyInlineParser, {}, []);
  let output = '';
  let start = 0;
  while (state.pos < state.posMax) {
    const match = /^<br\s*\/?\s*>\s*(?=(?:[-+*]|\d+[.)])\s+)/i.exec(line.slice(state.pos));
    if (match) {
      output += line.slice(start, state.pos) + '\n';
      state.pos += match[0].length;
      start = state.pos;
    } else bodyInlineParser.inline.skipToken(state);
  }
  return (output + line.slice(start)).split('\n');
}

function installTaskListTransform(md: MarkdownIt, github = false): void {
  md.core.ruler.after('inline', 'meo-task-list-transform', (state: any) => {
    const itemStack: Array<{ token: any; firstInlineHandled: boolean }> = [];

    for (const token of state.tokens as any[]) {
      if (token.type === 'list_item_open') {
        itemStack.push({ token, firstInlineHandled: false });
        continue;
      }

      if (token.type === 'list_item_close') {
        itemStack.pop();
        continue;
      }

      if (token.type !== 'inline' || itemStack.length === 0) {
        continue;
      }

      const current = itemStack[itemStack.length - 1];
      if (current.firstInlineHandled) {
        continue;
      }
      current.firstInlineHandled = true;

      const match = taskContentPrefix.exec(token.content ?? '');
      if (!match) {
        continue;
      }

      const statusClass = taskStatusClassFromMarker(match[1]);
      current.token.attrJoin('class', 'meo-export-task-item');
      current.token.attrJoin('class', statusClass);
      const parentItem = itemStack.at(-2)?.token;
      if (parentItem && current.token.map?.[0] === parentItem.map?.[0]) {
        current.token.attrJoin('class', 'meo-export-task-show-marker');
      }

      removeTaskPrefixFromInlineToken(token, match[0].length);

      const children = Array.isArray(token.children) ? token.children : [];
      const checkboxNode = new state.Token('html_inline', '', 0);
      checkboxNode.content = github
        ? `<input type="checkbox" class="meo-export-task-checkbox task-list-item-checkbox" disabled${statusClass === 'is-done' ? ' checked' : ''} aria-label="${statusClass === 'is-done' ? 'Completed task' : 'Incomplete task'}"> `
        : `<span class="meo-export-task-checkbox ${statusClass}" aria-hidden="true"></span>`;
      checkboxNode.meta = { ...(checkboxNode.meta ?? {}), meoTrustedHtml: true };
      const openTextNode = new state.Token('html_inline', '', 0);
      openTextNode.content = `<span class="meo-export-task-text ${statusClass}">`;
      openTextNode.meta = { ...(openTextNode.meta ?? {}), meoTrustedHtml: true };
      const closeTextNode = new state.Token('html_inline', '', 0);
      closeTextNode.content = '</span>';
      closeTextNode.meta = { ...(closeTextNode.meta ?? {}), meoTrustedHtml: true };

      token.children = [checkboxNode, openTextNode, ...children, closeTextNode];
    }
  });
}

function taskStatusClassFromMarker(marker: string): string {
  const normalized = marker.toLowerCase();
  if (normalized === 'x') {
    return 'is-done';
  }
  return 'is-todo';
}

function removeTaskPrefixFromInlineToken(token: any, prefixLength: number): void {
  token.content = String(token.content ?? '').slice(prefixLength);

  if (!Array.isArray(token.children) || prefixLength <= 0) {
    return;
  }

  let remaining = prefixLength;
  for (const child of token.children) {
    if (remaining <= 0) {
      break;
    }
    if (child.type !== 'text') {
      continue;
    }
    const content = String(child.content ?? '');
    if (!content) {
      continue;
    }
    if (content.length <= remaining) {
      remaining -= content.length;
      child.content = '';
      continue;
    }
    child.content = content.slice(remaining);
    remaining = 0;
  }

  token.children = token.children.filter((child: any) => !(child.type === 'text' && !child.content));
}

function installKbdFallbackTransform(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'meo-kbd-fallback-transform', (state: any) => {
    for (const token of state.tokens as any[]) {
      if (token.type !== 'inline' || !Array.isArray(token.children) || token.children.length === 0) {
        continue;
      }

      // markdown-it keeps malformed inline HTML tokens as raw HTML; convert unmatched
      // <kbd> tags to text so export escapes them and preserves literal source.
      const openStack: any[] = [];
      for (const child of token.children) {
        if (child.type !== 'html_inline') {
          continue;
        }

        const content = String(child.content ?? '').trim();
        if (OPENING_KBD_TAG_RE.test(content)) {
          openStack.push(child);
          continue;
        }

        if (!CLOSING_KBD_TAG_RE.test(content)) {
          continue;
        }

        if (openStack.length > 0) {
          openStack.pop();
          continue;
        }

        convertHtmlInlineTagTokenToText(child);
      }

      for (const unmatchedOpen of openStack) {
        convertHtmlInlineTagTokenToText(unmatchedOpen);
      }
    }
  });
}

function convertHtmlInlineTagTokenToText(token: any): void {
  token.type = 'text';
  token.tag = '';
  token.nesting = 0;
}

const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
type AlertType = typeof ALERT_TYPES[number];

type IconNode = [string, Record<string, string>][];

function renderLucideIcon(iconNode: IconNode): string {
  const innerHtml = iconNode.map(([tag, attrs]) => {
    const attrString = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${attrString}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${innerHtml}</svg>`;
}

const ALERT_ICONS: Record<AlertType, string> = {
  NOTE: renderLucideIcon(Info as unknown as IconNode),
  TIP: renderLucideIcon(Lightbulb as unknown as IconNode),
  IMPORTANT: renderLucideIcon(AlertCircle as unknown as IconNode),
  WARNING: renderLucideIcon(AlertTriangle as unknown as IconNode),
  CAUTION: renderLucideIcon(XCircle as unknown as IconNode)
};

function installAlertTransform(md: MarkdownIt, alertLabel: (type: string) => string, github = false): void {
  const defaultBlockquoteRender = md.renderer.rules.blockquote_open ??
    ((tokens: any, idx: number, opts: any, _env: any, self: any) => self.renderToken(tokens, idx, opts));

  md.renderer.rules.blockquote_open = (tokens: any, idx: number, opts: any, env: any, self: any) => {
    const openToken = tokens[idx];
    if (github && openToken.level > 0) return defaultBlockquoteRender(tokens, idx, opts, env, self);
    if (github && (tokens[idx + 1]?.type !== 'paragraph_open' || tokens[idx + 2]?.type !== 'inline')) {
      return defaultBlockquoteRender(tokens, idx, opts, env, self);
    }
    let alertType: AlertType | null = null;
    let headerHtml = '';
    const TokenCons = tokens[0].constructor as any;

    for (let i = idx + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type === 'blockquote_close') break;
      if (token.type === 'paragraph_open') continue;
      if (token.type === 'inline' && token.content) {
        const match = (github ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?=\s*(?:\n|$))/i : /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i).exec(token.content.trim());
        if (match) {
          alertType = match[1].toUpperCase() as AlertType;
          headerHtml = [
            '<span class="meo-export-alert-header">',
            `<span class="meo-export-alert-icon">${ALERT_ICONS[alertType]}</span>`,
            `<span class="meo-export-alert-label">${escapeHtml(alertLabel(alertType))}</span>`,
            '</span>'
          ].join('');
          token.content = token.content.replace(match[0], '').trim();
          if (!token.content && tokens[i + 1]?.type === 'paragraph_close') {
            token.content = '';
            token.children = [];
          }
        }
        break;
      }
    }

    if (alertType && ALERT_TYPES.includes(alertType)) {
      openToken.attrJoin('class', `meo-export-alert meo-export-alert-${alertType.toLowerCase()}`);

      let insertedHeader = false;
      for (let i = idx + 1; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.type === 'blockquote_close') break;
        if (token.type !== 'inline') {
          continue;
        }

        if (token.children && !github) {
          for (const child of token.children) {
            if (child.type === 'softbreak') {
              child.type = 'hardbreak';
              child.tag = 'br';
              child.nesting = 0;
            }
          }
        }

        if (insertedHeader) {
          continue;
        }

        const htmlNode = new TokenCons('html_inline', '', 0);
        htmlNode.content = headerHtml;
        htmlNode.meta = { ...(htmlNode.meta ?? {}), meoTrustedHtml: true };

        token.children = token.children ?? [];
        token.children.unshift(htmlNode);

        for (const child of token.children) {
          if (child.type === 'text') {
            child.content = child.content.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, '').trimLeft();
            break;
          }
        }

        if (github) {
          token.children = token.children.filter((child: any) => child.type !== 'text' || child.content !== '');
          if (['softbreak', 'hardbreak'].includes(token.children[1]?.type)) token.children.splice(1, 1);
        }

        insertedHeader = true;
      }
    }

    return defaultBlockquoteRender(tokens, idx, opts, env, self);
  };
}

function renderGithubFrontmatter(lines: string[], bodyStartLine: number): string {
  const end = bodyStartLine - 1;
  try {
    const value = loadYaml(lines.slice(1, end - 1).join('\n'));
    const fields: Array<[string, unknown]> = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value) : [['value', value]];
    const text = (entry: unknown): string => entry === null || entry === undefined ? ''
      : Array.isArray(entry) ? entry.map(text).join(', ')
      : typeof entry === 'object' ? JSON.stringify(entry) : String(entry);
    return `<div class="meo-export-frontmatter" data-source-line="1" data-source-end-line="${end}"><table><tbody>${fields.map(([key, entry]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(text(entry))}</td></tr>`).join('')}</tbody></table></div>`;
  } catch {
    // Cyclic YAML aliases cannot be projected into table cells; retain their source.
    return `<pre data-source-line="1" data-source-end-line="${end}"><code>${escapeHtml(lines.slice(0, end).join('\n'))}</code></pre>`;
  }
}

function highlightFence(code: string, language: string): string {
  if (!language) return escapeHtml(code);
  // The installed runtime keeps the complete fallback catalogue in a lazy
  // bundle. Text and supplied/viewport highlighting do not need its grammars.
  const fallback = require('./fallbackCodeHighlighter') as typeof import('./fallbackCodeHighlighter');
  return fallback.highlightFence(code, language) ?? escapeHtml(code);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
