import { markdownHeadingAnchor } from '../foundation/markdownHeadingAnchor';
import { normalizeLinkDestination, isLocalFileLinkDestination } from '../foundation/linkDestination';
import { splitMarkdownTableRow } from '../foundation/markdownTableRow';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';
import { Parser, parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';
import { isLocalImageSrc, rewriteExportImageSrc, rewriteExportLinkHref } from './assetPaths';
import { extractExportFrontmatter } from './frontmatter';
import { prepareMarkdownWithFootnotes } from './footnotes';
import type { SourceMappedMarkdown } from './sourceMappedMarkdown';
import { installMathTransform } from './mathTransform';
import { collectMarkdownCodeLines } from './markdownCodeLines';
import { renderLatexMathPresentation } from './math';
import { isMathFenceLanguage, mathFenceBodyRange, mathFenceContent } from '../shared/mathFence';
import { installHighlightTransform } from './highlightTransform';
import { installInlineScriptTransform } from './inlineScriptTransform';
import { installPunctuationInlineTransform } from './punctuationInlineTransform';
import { Info, Lightbulb, AlertCircle, AlertTriangle, XCircle } from 'lucide';
import {
  getSupportedHtmlAttributes,
  matchInlineHtmlCode,
  isSupportedHtmlSource,
  supportedHtmlTags
} from '../shared/htmlPolicy';
import type { UiLanguage } from '../foundation/uiLanguage';
import { getReadingUiStrings } from './readingUiLanguage';
import { normalizeFenceLanguage } from './fenceLanguage';
import { markdownPresentationBlocks, type MarkdownPresentationBlock } from './markdownPresentationBlocks';
import type { PreviewDocumentHeading } from '../foundation/previewDocument';
import { getPreviewPreset, type PreviewPresetId, type PreviewPresetDefinition } from '../foundation/previewPresets';
import { load as loadYaml } from 'js-yaml';
import { installWikiReferenceTransform } from './wikiReferences';
import type { ResolvedWikiResources } from '../foundation/wikiReference';
import { addGithubDetailsSummary, createGithubHtmlSanitizer, githubHtmlAttributes, githubHtmlTags, installGithubInlineRules, isGithubImageSource, isGithubLink, linkifyGithubFilteredHtml, replaceGithubEmoji, stripGithubSelectMarkup } from './githubReadme';

const POWER_QUERY_KEYWORDS =
  'let in each if then else try otherwise error and or not as is type meta section shared';
const POWER_QUERY_HASH_KEYWORDS =
  '#date #time #datetime #datetimezone #duration #table #binary #sections #shared';
const OPENING_KBD_TAG_RE = /^<kbd\b[^>]*>$/i;
const CLOSING_KBD_TAG_RE = /^<\/kbd\s*>$/i;
const DEFERRED_IMAGE_ATTRIBUTE = 'data-meo-deferred-image-src';
const DEFERRED_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

// Only context-free fallback token HTML is retained. Source positions, wrappers,
// appearance, and document sanitization are recomputed on every render.
const FENCE_HIGHLIGHT_CACHE_ENTRIES = 256;
const FENCE_HIGHLIGHT_CACHE_BYTES = 8 * 1024 * 1024;
const FENCE_HIGHLIGHT_ENTRY_BYTES = 256 * 1024;
const fenceHighlightCache = new Map<string, string>();
let fenceHighlightCacheBytes = 0;

registerExportLanguages();

export type RenderMarkdownTarget = 'html' | 'pdf' | 'docx';

export type RenderMarkdownOptions = {
  wikiResources?: ResolvedWikiResources;
  markdownText: string;
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
  /** Prepared Preview contexts expose individual endnotes as reading blocks. */
  windowedFootnotes?: boolean;
  /** Permit local file destinations alongside the preset's safe URL schemes. */
  allowLocalLinks?: boolean;
  showComments?: boolean;
  /** Standalone exports inject the same Shiki token presentation used by Live and Preview. */
  highlightCode?: (source: string, language: string) => string;
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
  blocks: readonly MarkdownPresentationBlock[];
  hasMermaid: boolean;
  headings: readonly PreviewDocumentHeading[];
  renderBlock(index: number): RenderMarkdownResult;
  renderAll(): RenderMarkdownResult;
}>;

export function renderMarkdownToHtml(options: RenderMarkdownOptions): RenderMarkdownResult {
  return prepareMarkdownPresentation(options).renderAll();
}

/** Parse global Markdown context once. HTML generation is a separate, demand-driven step. */
export function prepareMarkdownPresentation(options: RenderMarkdownOptions): MarkdownPresentation {
  const github = (options.presetDefinition ?? getPreviewPreset(options.preset)).renderer === 'github-readme';
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
    github && !isGithubImageSource(rawSrc) ? { src: '' } :
    options.deferImages && (isLocalImageSrc(rawSrc) || /^(?:https?:)?\/\//i.test(rawSrc.trim()))
      ? { src: DEFERRED_IMAGE_PLACEHOLDER, deferredSrc: rawSrc }
      : { src: rewriteImageSrc(rawSrc) }
  );
  const originalSourceLines = String(options.markdownText ?? '').split(/\r?\n/);
  const normalized = { markdown: String(options.markdownText ?? ''), sourceLines: originalSourceLines.map((_, index) => index + 1) };
  const extractedFrontmatter = extractExportFrontmatter(normalized, uiStrings.properties);
  const shouldEnableMathTransform = extractedFrontmatter.body.markdown.includes('$');

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: !github,
    langPrefix: 'language-'
  });
  if (github) installGithubInlineRules(md);
  const allowLocalLinks = !github || options.allowLocalLinks === true;
  const normalizeHref = (href: string) => options.deferLocalLinks || !allowLocalLinks
    ? normalizeLinkDestination(href) : rewriteExportLinkHref(href, options);
  const normalizeLink = md.normalizeLink.bind(md), validateLink = md.validateLink.bind(md);
  md.normalizeLink = href => normalizeLink(normalizeHref(href));
  md.validateLink = href => allowLocalLinks && isLocalFileLinkDestination(href) || validateLink(href);
  const githubHtml = github ? createGithubHtmlSanitizer(deferImageSrc, allowLocalLinks) : undefined;
  // The bundled backtick rule strips bounding spaces even from all-space code.
  // Preserve that CommonMark exception before the regular rule handles other spans.
  md.inline.ruler.before('backticks', 'meo_code_space_literal', (state, silent) => {
    if (state.src[state.pos] !== '`') return false;
    const match = /^(`+)([ \n]+)\1(?!`)/.exec(state.src.slice(state.pos, state.posMax));
    if (!match) return false;
    if (!silent) {
      const inlineCode = state.push('code_inline', 'code', 0);
      inlineCode.markup = match[1];
      inlineCode.content = match[2].replace(/\n/g, ' ');
    }
    state.pos += match[0].length;
    return true;
  });
  if (!github) {
    installWikiReferenceTransform(md, options.deferImages === true, options.wikiResources);
    installHighlightTransform(md);
    installInlineScriptTransform(md);
    installPunctuationInlineTransform(md);
  }
  installSourcePositionAndHeadingAnchorTransform(md, (startIndex, endIndex) => ({
    start: bodySourceLines?.[startIndex] ?? 0,
    end: bodySourceLines?.[Math.max(startIndex, endIndex - 1)] ?? 0
  }), (heading) => headings.push(heading), github);
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
    (startIndex, endIndex) => ({
      start: bodySourceLines?.[startIndex] ?? 0,
      end: bodySourceLines?.[Math.max(startIndex, endIndex - 1)] ?? 0
    }),
    !github && options.showComments === true,
    !github,
    github ? generatedFootnoteTags : undefined,
    githubHtml?.sanitize
  );
  if (shouldEnableMathTransform) {
    installMathTransform(md, {
      githubStyle: github,
      deferDisplay: options.deferDisplayMath,
      onRenderedMath: () => {
        hasMath = true;
      }
    });
  }

  const defaultImageRule = md.renderer.rules.image ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  const imageSources = new WeakMap<object, string>();
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const imageNode = tokens[idx];
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
    const richLanguage = github ? codeBlock.info.trim().split(/\s+/)[0] : language;
    const renderRichContent = !github || !env?.meoGithubFootnote;

    if (renderRichContent && (github ? richLanguage === 'math' : isMathFenceLanguage(language))) {
      const mathContent = mathFenceContent(source);
      const presentation = renderLatexMathPresentation(mathContent, 'display', options.deferDisplayMath);
      if (presentation) {
        hasMath = true;
        const copySource = source.replace(/\n$/, '');
        const body = mathFenceBodyRange(copySource);
        const sourceB64 = Buffer.from(copySource.slice(body.from, body.to), 'utf8').toString('base64');
        return `<div class="meo-export-math meo-export-math-display meo-export-math-fenced-display" data-source-b64="${sourceB64}"${presentation.attributes}${sourceAttrs}>${presentation.html}</div>`;
      }
    }

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

    const highlighted = options.highlightCode?.(source, language) ?? highlightFence(source, language);
    const className = language ? ` class="hljs language-${escapeHtmlAttr(language)}"` : ' class="hljs"';
    const languageLabel = language
      ? `<div class="meo-export-code-language-label">${escapeHtml(language)}</div>`
      : '';
    return [
      `<div class="meo-export-code-block-wrap"${sourceAttrs}>`,
      languageLabel,
      `<pre class="meo-export-code-block"><code${className}>${renderHighlightedCodeLines(highlighted, source, options.target)}</code></pre>`,
      '</div>'
    ].join('');
  };
  md.renderer.rules.fence = renderCodeBlock;
  md.renderer.rules.code_block = renderCodeBlock;
  const preparedMarkdown = prepareMarkdownWithFootnotes(extractedFrontmatter.body, {
    githubStyle: github,
    ...(github ? { onReferenceTags: (tags: readonly string[]) => tags.forEach(tag => generatedFootnoteTags.add(tag)) } : {}),
    target: options.target,
    outputFilePath: options.outputFilePath,
    renderMarkdown: (markdownText) => md.render(markdownText, github ? { meoGithubFootnote: true } : undefined),
    prepareMarkdown: markdownText => {
      const context = github ? { meoGithubFootnote: true } : {};
      const nodes = md.parse(markdownText, context);
      if (!github) hasMermaid ||= nodes.some(node => node.type === 'fence' && normalizeFenceLanguage(node.info) === 'mermaid');
      return () => md.renderer.render(nodes, md.options, context);
    },
    normalizeMarkdown: github ? text => text : normalizeMarkdownForExport,
    backToReference: uiStrings.backToReference,
    backToNumberedReference: uiStrings.backToNumberedReference,
    backToReferenceOccurrence: uiStrings.backToReferenceOccurrence
  });
  // Extract definitions before table normalization can change their four-space
  // continuation indent and accidentally detach subsequent blocks.
  const normalizedBody = github
    ? { markdown: preparedMarkdown.body.markdown, sourceLines: preparedMarkdown.body.markdown.split(/\r?\n/).map((_, index) => index + 1) }
    : normalizeMarkdownForExportWithSourceMap(preparedMarkdown.body.markdown);
  bodySourceLines = normalizedBody.sourceLines.map(line => preparedMarkdown.body.sourceLines[line - 1] ?? line);
  headings.length = 0;
  const environment = {};
  const bodyTokens = md.parse(normalizedBody.markdown, environment);
  hasMermaid ||= bodyTokens.some(node => node.type === 'fence'
    && (github ? node.info.trim().split(/\s+/)[0] : normalizeFenceLanguage(node.info)) === 'mermaid');
  const tokenBlocks = markdownPresentationBlocks(bodyTokens, bodySourceLines);
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
    allowedAttributes: {
      ...(github ? { input: ['type', 'disabled', 'checked', 'aria-label'] } : {}),
      ...(github ? Object.fromEntries(Object.entries(githubHtmlAttributes).filter(([tag]) => !['*', 'a', 'img', 'ol', 'th', 'td', 'p', 'div', 'span', 'details'].includes(tag))) : {}),
      ...(github ? { source: ['srcset', 'data-meo-deferred-image-srcset'] } : {}),
      a: ['href', 'name', 'target', 'rel', 'title', 'aria-label'],
      details: ['open'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', DEFERRED_IMAGE_ATTRIBUTE, ...(github ? githubHtmlAttributes.img : [])],
      ol: ['start', 'reversed', ...(github ? githubHtmlAttributes.ol : [])],
      li: ['value'],
      '*': ['class', 'style', 'id', 'data-source-b64', 'data-meo-deferred-math', 'data-source-line', 'data-source-end-line', 'aria-hidden', ...(github ? githubHtmlAttributes['*'] : [])],
      span: ['class', 'style', 'title', 'role', 'aria-label', 'aria-hidden', 'data-line-number'],
      th: ['colspan', 'rowspan', 'scope', 'style'],
      td: ['colspan', 'rowspan', 'style'],
      code: ['class'],
      p: ['align'],
      div: ['class', 'data-source-b64', 'align', ...(github ? githubHtmlAttributes.div : [])],
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
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'file', 'data', 'meo-wiki'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'file', 'data'],
      ...(github ? { srcset: ['http', 'https', 'file', 'data'] } : {})
    },
    allowProtocolRelative: github,
    ...(github ? { nonTextTags: ['script', 'style', 'textarea', 'option', 'video'] } : {}),
    ...(github ? { exclusiveFilter: (frame: sanitizeHtml.IFrame) => frame.tag === 'a' && !frame.attribs.href && !frame.attribs.id && !frame.attribs.name ? 'excludeTag' as const : false } : {}),
    allowedStyles: {
      img: { width: [/^\d+px$/], height: [/^\d+px$/] },
      '*': {
        'text-align': [/^left$/i, /^right$/i, /^center$/i, /^justify$/i],
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
    },
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
  const prefix = tableOfContentsHtml + frontmatterHtml;
  const prefixBlocks: MarkdownPresentationBlock[] = prefix ? [{ index: 0, sourceLine: 1,
    sourceEndLine: Math.max(1, (extractedFrontmatter.body.sourceLines[0] ?? 1) - 1),
    kind: 'frontmatter', sourceCharacters: prefix.length }] : [];
  const blocks: MarkdownPresentationBlock[] = [...prefixBlocks, ...tokenBlocks.map(({ from: _from, to: _to, ...block }) => ({
    ...block, index: block.index + prefixBlocks.length
  }))];
  const footnotes = preparedMarkdown.footnotes;
  const splitFootnotes = options.windowedFootnotes === true && footnotes.length > 1;
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
    blocks,
    hasMermaid,
    headings: headings.map(heading => ({ ...heading })),
    renderBlock(index) {
      if (!Number.isInteger(index) || index < 0 || index >= blocks.length) throw new RangeError('Unknown Markdown presentation block');
      if (prefixBlocks.length && index === 0) return sanitize(prefix);
      const block = tokenBlocks[index - prefixBlocks.length];
      const footerIndex = index - prefixBlocks.length - tokenBlocks.length;
      if (!block && splitFootnotes) {
        const note = footnotes[footerIndex]!;
        return sanitize(`<section class="footnotes${footerIndex ? ' meo-preview-footnotes-continuation' : ''}" data-source-line="${note.sourceLine}" data-source-end-line="${note.sourceEndLine}">`
          + `<ol class="footnotes-list" start="${footerIndex + 1}">${note.render()}</ol></section>`);
      }
      return sanitize(block
        ? md.renderer.render(bodyTokens.slice(block.from, block.to), md.options, environment)
        : preparedMarkdown.footnotesHtml);
    },
    renderAll: () => sanitize(prefix + md.renderer.render(bodyTokens, md.options, environment) + preparedMarkdown.footnotesHtml)
  };
}

function renderHighlightedCodeLines(highlighted: string, source: string, target: RenderMarkdownOptions['target']): string {
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
  return rows.map((row, index) => [
    '<span class="meo-export-code-line">',
    `<span class="meo-export-code-line-number" aria-hidden="true" data-line-number="${index + 1}"></span>`,
    `<span class="meo-export-code-line-source">${row}${target !== 'docx' && source.length > 0 && sourceLines[index] === '' ? '<br>' : ''}</span>`,
    '</span>'
  ].join('')).join('') + (source.endsWith('\n') ? '\n' : '');
}

function installSafeHtmlTransform(
  md: MarkdownIt,
  rewriteImageSrc: (rawSrc: string) => { src: string; deferredSrc?: string },
  resolveSourceRange: (startIndex: number, endIndex: number) => { start: number; end: number },
  showComments: boolean,
  preserveSourceStyles = true,
  generatedFootnoteTags?: ReadonlySet<string>,
  githubSanitize?: (source: string) => string
): void {
  // HTML code contents are literal, including when another paragraph enables math rendering.
  if (!githubSanitize) md.inline.ruler.before('html_inline', 'meo_literal_html_code', (state, silent) => {
    const match = matchInlineHtmlCode(state.src, state.pos, state.posMax);
    if (!match) return false;
    if (!silent) state.push('html_inline', '', 0).content = state.src.slice(state.pos, match.to);
    state.pos = match.to;
    return true;
  });
  const allowedAttributes = Object.fromEntries(
    [...supportedHtmlTags].map((tagName) => [tagName, getSupportedHtmlAttributes(tagName)
      .filter(attribute => preserveSourceStyles || !['style', 'class', 'id'].includes(attribute))])
  );
  allowedAttributes.img = [...allowedAttributes.img, DEFERRED_IMAGE_ATTRIBUTE];
  const safeHtmlSanitizerOptions: NonNullable<Parameters<typeof sanitizeHtml>[1]> = {
    allowedTags: [...supportedHtmlTags],
    allowedAttributes,
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'file', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'file', 'data']
    },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, ...(attribs.href ? { href: normalizeLinkDestination(attribs.href) } : {}) } }),
      img: (tagName, attribs) => {
        const rewritten = attribs.src ? rewriteImageSrc(attribs.src) : null;
        return {
          tagName,
          attribs: {
            ...attribs,
            ...(rewritten ? { src: rewritten.src } : {}),
            ...(rewritten?.deferredSrc ? { [DEFERRED_IMAGE_ATTRIBUTE]: rewritten.deferredSrc } : {})
          }
        };
      }
    }
  };
  const sanitizeRawSource = (source: string, tokenType: string): string => {
    if (!preserveSourceStyles && tokenType === 'html_block' && isSupportedHtmlSource(source)) {
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
        onclosetag: (_name, implied) => { if (!implied) append(source.slice(parser.startIndex, parser.endIndex + 1)); },
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
    if (closingTag) return `</${closingTag[1].toLowerCase()}>`;

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
  const renderRawHtml = (tokens: any[], index: number): string => {
    const htmlNode = tokens[index];
    const source = String(htmlNode?.content ?? '');
    if (htmlNode?.meta?.meoTrustedHtml === true || generatedFootnoteTags?.has(source)) return source;
    let rendered = githubSanitize ? githubSanitize(source) : sanitizeRawSource(source, String(htmlNode?.type ?? ''));
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
    const sourceRange = resolveSourceRange(Number(htmlNode.map[0]), Number(htmlNode.map[1]));
    if (sourceRange.start <= 0) return rendered;
    if (!preserveSourceStyles) {
      return rendered.replace(/^(\s*<[a-z][a-z\d-]*)(?=[\s>])/i, `$1 data-source-line="${sourceRange.start}" data-source-end-line="${Math.max(sourceRange.start, sourceRange.end)}"`);
    }
    return `<div class="meo-export-html-block" data-source-line="${sourceRange.start}" data-source-end-line="${Math.max(sourceRange.start, sourceRange.end)}">${rendered}</div>`;
  };
  md.renderer.rules.html_block = renderRawHtml;
  md.renderer.rules.html_inline = renderRawHtml;
}

function installSourcePositionAndHeadingAnchorTransform(
  md: MarkdownIt,
  resolveSourceRange: (startIndex: number, endIndex: number) => { start: number; end: number },
  onHeading?: (heading: ExportHeading) => void,
  github = false
): void {
  md.core.ruler.after('inline', 'meo-heading-anchors', (state: any) => {
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
      const sourceRange = Array.isArray(headingOpen.map)
        ? resolveSourceRange(Number(headingOpen.map[0]), Number(headingOpen.map[1]))
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
          onHeading?.({ level: Number(match[1]), id, text, line: sourceLine });
        }
        if (ids.length) headingOpen.meta = { ...headingOpen.meta, meoGithubHeadingIds: ids };
      }
      if ((headingOpen.nesting === 1 || headingOpen.type === 'fence' || headingOpen.type === 'code_block' || headingOpen.type === 'meo_math_block') && sourceLine > 0) {
        headingOpen.attrSet('data-source-line', String(sourceLine));
        headingOpen.attrSet('data-source-end-line', String(Math.max(sourceLine, sourceEndLine)));
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
      onHeading?.({
        level: Number.parseInt(String(headingOpen.tag).slice(1), 10),
        id,
        text: extractHeadingText(inlineContent),
        line: sourceLine
      });

    }
  });
}

function installTableContainerTransform(md: MarkdownIt, resolveIndent: (sourceLine: number) => number): void {
  const defaultTableOpen = md.renderer.rules.table_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose = md.renderer.rules.table_close ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
    const sourceLine = Number(tokens[idx]?.attrGet('data-source-line') ?? 0);
    const indent = tokens[idx]?.level === 0 && sourceLine > 0 ? resolveIndent(sourceLine) : 0;
    const wrapperAttributes = indent > 0
      ? ` class="meo-table-scroll meo-export-indented-table" style="--meo-table-indent:${indent}ch"`
      : ' class="meo-table-scroll"';
    return `<div${wrapperAttributes}>${defaultTableOpen(tokens, idx, options, env, self)}`;
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

function normalizeMarkdownForExportWithSourceMap(markdownText: string): SourceMappedMarkdown {
  const codeLines = collectMarkdownCodeLines(markdownText);
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
    if (!isTableDelimiterLine(delimiter) || !isTableHeaderLine(lines[index - 1] ?? '')) {
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
  const trimmed = line.trim();
  return /^\|?\s*:?[-]{3,}:?\s*(?:\|\s*:?[-]{3,}:?\s*)*\|?$/.test(trimmed);
}

const bodyInlineParser = new MarkdownIt({ html: true });

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

      const match = (github ? /^\[([ xX])\]\s+/ : /^\[([ xX~\-])\]\s+/).exec(token.content ?? '');
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
  if (normalized === '~') {
    return 'is-inprogress';
  }
  if (normalized === '-') {
    return 'is-dropped';
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

function registerExportLanguages(): void {
  if (hljs.getLanguage('powerquery')) {
    return;
  }

  hljs.registerLanguage('powerquery', () => ({
    name: 'PowerQuery',
    keywords: {
      keyword: POWER_QUERY_KEYWORDS,
      literal: 'true false null',
      built_in: POWER_QUERY_HASH_KEYWORDS
    },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.COMMENT(/\/\*/, /\*\//),
      {
        className: 'property',
        begin: /\[[^\]\r\n]+\]/
      },
      {
        className: 'variable',
        begin: /@[a-z_][a-z0-9_]*/i
      },
      {
        className: 'string',
        variants: [
          {
            begin: /#?"/,
            end: /(?<!")"(?!")/,
            contains: [{ begin: /""/ }]
          }
        ]
      },
      {
        className: 'number',
        begin: /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i
      }
    ]
  }));
}

function highlightFence(code: string, language: string): string {
  if (language && hljs.getLanguage(language)) {
    // JSON owns an unambiguous key without retaining a slice of a larger document.
    const key = code.length * 2 <= FENCE_HIGHLIGHT_ENTRY_BYTES
      ? JSON.stringify([language, code])
      : null;
    const cached = key === null ? undefined : fenceHighlightCache.get(key);
    if (cached !== undefined && key !== null) {
      fenceHighlightCache.delete(key);
      fenceHighlightCache.set(key, cached);
      return cached;
    }
    try {
      const result = hljs.highlight(code, { language, ignoreIllegals: true });
      // A transient failure must be retried, including highlight.js safe-mode errors.
      if (key !== null && !result.errorRaised && !result.illegal) cacheFenceHighlight(key, result.value);
      return result.value;
    } catch {
      // Fallback to escaped plain text.
    }
  }
  return escapeHtml(code);
}

function cacheFenceHighlight(key: string, html: string): void {
  const bytes = (key.length + html.length) * 2;
  if (bytes > FENCE_HIGHLIGHT_ENTRY_BYTES) return;
  // Bound UTF-16 text payload as well as entry count; a few large fences must not
  // pin arbitrarily large documents for the lifetime of the extension Host.
  while (fenceHighlightCache.size >= FENCE_HIGHLIGHT_CACHE_ENTRIES
    || fenceHighlightCacheBytes + bytes > FENCE_HIGHLIGHT_CACHE_BYTES) {
    const oldest = fenceHighlightCache.keys().next().value!;
    fenceHighlightCacheBytes -= (oldest.length + fenceHighlightCache.get(oldest)!.length) * 2;
    fenceHighlightCache.delete(oldest);
  }
  // Plain token HTML can still be a slice of MarkdownIt's complete source.
  // Detach it before retention so the payload limit also releases parent documents.
  fenceHighlightCache.set(key, JSON.parse(JSON.stringify(html)) as string);
  fenceHighlightCacheBytes += bytes;
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
