import MarkdownIt from 'markdown-it';
import { full as emoji } from 'markdown-it-emoji';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';
import { rewriteExportImageSrc, type ExportHtmlImageMode } from './assetPaths';
import { extractExportFrontmatter } from './frontmatter';
import { prepareMarkdownWithFootnotes } from './footnotes';
import type { SourceMappedMarkdown } from './sourceMappedMarkdown';
import { installMathTransform } from './mathTransform';
import { collectLatexMathRanges, renderLatexMathToHtml } from './math';
import { installHighlightTransform } from './highlightTransform';
import { Info, Lightbulb, AlertCircle, AlertTriangle, XCircle } from 'lucide';

const POWER_QUERY_KEYWORDS =
  'let in each if then else try otherwise error and or not as is type meta section shared';
const POWER_QUERY_HASH_KEYWORDS =
  '#date #time #datetime #datetimezone #duration #table #binary #sections #shared';
const FENCE_LANGUAGE_ALIASES: Record<string, string> = {
  m: 'powerquery',
  pq: 'powerquery',
  rs: 'rust',
  golang: 'go',
  cs: 'csharp',
  'c#': 'csharp'
};
const MATH_FENCE_LANGUAGES = new Set(['latex', 'tex', 'math', 'katex']);
const OPENING_KBD_TAG_RE = /^<kbd\b[^>]*>$/i;
const CLOSING_KBD_TAG_RE = /^<\/kbd\s*>$/i;

registerExportLanguages();

export type RenderMarkdownTarget = 'html' | 'pdf';

export type RenderMarkdownOptions = {
  markdownText: string;
  markdownFilePath: string;
  outputFilePath?: string;
  target: RenderMarkdownTarget;
  htmlImageMode?: ExportHtmlImageMode;
};

export type RenderMarkdownResult = {
  html: string;
  hasMermaid: boolean;
  hasMath: boolean;
};

export function renderMarkdownToHtml(options: RenderMarkdownOptions): RenderMarkdownResult {
  let hasMermaid = false;
  let hasMath = false;
  let bodySourceLines: number[] | null = null;
  const embeddedImageDataUrlCache = new Map<string, string | null>();
  const originalSourceLines = String(options.markdownText ?? '').split(/\r?\n/);
  const normalized = normalizeMarkdownForExportWithSourceMap(options.markdownText);
  const extractedFrontmatter = extractExportFrontmatter(normalized);
  const shouldEnableMathTransform = extractedFrontmatter.body.markdown.includes('$');

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: true,
    langPrefix: 'language-'
  });
  md.use(emoji);
  installHighlightTransform(md);
  installSourcePositionAndHeadingAnchorTransform(md, (startIndex, endIndex) => ({
    start: bodySourceLines?.[startIndex] ?? 0,
    end: bodySourceLines?.[Math.max(startIndex, endIndex - 1)] ?? 0
  }));
  installTableContainerTransform(md, (sourceLine) => (
    countLeadingIndentColumns(originalSourceLines[sourceLine - 1] ?? '')
  ));
  installTableCellListTransform(md);
  installTaskListTransform(md);
  installKbdFallbackTransform(md);
  installAlertTransform(md);
  if (shouldEnableMathTransform) {
    installMathTransform(md, {
      onRenderedMath: () => {
        hasMath = true;
      }
    });
  }

  const defaultImageRule = md.renderer.rules.image ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') ?? '';
    const rewritten = rewriteExportImageSrc(src, {
      markdownFilePath: options.markdownFilePath,
      outputFilePath: options.outputFilePath,
      target: options.target,
      htmlImageMode: options.htmlImageMode ?? 'embedded',
      embeddedImageDataUrlCache
    });
    token.attrSet('src', rewritten);
    token.attrSet('loading', 'eager');
    return defaultImageRule(tokens, idx, opts, env, self);
  };

  const preparedMarkdown = prepareMarkdownWithFootnotes(extractedFrontmatter.body, {
    target: options.target,
    outputFilePath: options.outputFilePath,
    renderMarkdown: (markdownText) => md.render(markdownText),
    normalizeMarkdown: normalizeMarkdownForExport
  });
  md.renderer.rules.fence = (tokens, idx) => {
    const fenceBlock = tokens[idx];
    const language = normalizeFenceLanguage(fenceBlock.info);
    const sourceLine = fenceBlock.attrGet('data-source-line');
    const sourceEndLine = fenceBlock.attrGet('data-source-end-line');
    const sourceAttrs = sourceLine
      ? ` data-source-line="${escapeHtmlAttr(sourceLine)}"${sourceEndLine ? ` data-source-end-line="${escapeHtmlAttr(sourceEndLine)}"` : ''}`
      : '';
    const source = String(fenceBlock.content ?? '');

    if (MATH_FENCE_LANGUAGES.has(language)) {
      const trimmedSource = source.trim();
      const ranges = collectLatexMathRanges(trimmedSource);
      const mathContent = ranges.length === 1 && ranges[0].from === 0 && ranges[0].to === trimmedSource.length
        ? ranges[0].content
        : trimmedSource.replace(/^\$\$\s*/, '').replace(/\s*\$\$$/, '').trim();
      const renderedMath = renderLatexMathToHtml(mathContent, 'display');
      if (renderedMath) {
        hasMath = true;
        return `<div class="meo-export-math meo-export-math-display meo-export-math-fenced-display"${sourceAttrs}>${renderedMath}</div>`;
      }
    }

    if (language === 'mermaid') {
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

    const highlighted = highlightFence(source, language);
    const className = language ? ` class="hljs language-${escapeHtmlAttr(language)}"` : ' class="hljs"';
    const languageLabel = language
      ? `<div class="meo-export-code-language-label">${escapeHtml(language)}</div>`
      : '';
    return [
      `<div class="meo-export-code-block-wrap"${sourceAttrs}>`,
      languageLabel,
      `<pre class="meo-export-code-block"><code${className}>${highlighted}</code></pre>`,
      '</div>'
    ].join('');
  };
  bodySourceLines = preparedMarkdown.body.sourceLines;
  const bodyHtml = md.render(preparedMarkdown.body.markdown);
  const rawHtml = [
    extractedFrontmatter.frontmatterHtml,
    bodyHtml,
    preparedMarkdown.footnotesHtml
  ].join('');
  const html = sanitizeHtml(rawHtml, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'mark',
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
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      '*': ['class', 'style', 'id', 'data-source-b64', 'data-source-line', 'data-source-end-line', 'aria-hidden'],
      th: ['colspan', 'rowspan', 'style'],
      td: ['colspan', 'rowspan', 'style'],
      code: ['class'],
      div: ['class', 'data-source-b64'],
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
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'file', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'file', 'data']
    },
    allowProtocolRelative: false,
    allowedStyles: {
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
        color: [/^[-#(),.%\w\s]+$/]
      }
    },
    transformTags: {
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
        const href = `${attribs.href ?? ''}`.trim();
        const next = { ...attribs };
        if (/^https?:/i.test(href)) {
          next.target = '_blank';
          next.rel = 'noopener noreferrer';
        }
        return { tagName, attribs: next };
      }
    }
  });

  return { html, hasMermaid, hasMath };
}

function installSourcePositionAndHeadingAnchorTransform(
  md: MarkdownIt,
  resolveSourceRange: (startIndex: number, endIndex: number) => { start: number; end: number }
): void {
  md.core.ruler.after('inline', 'meo-heading-anchors', (state: any) => {
    const slugCounts = new Map<string, number>();
    const tokens = state.tokens as any[];

    for (let index = 0; index < tokens.length; index += 1) {
      const headingOpen = tokens[index];
      const sourceRange = Array.isArray(headingOpen.map)
        ? resolveSourceRange(Number(headingOpen.map[0]), Number(headingOpen.map[1]))
        : null;
      const sourceLine = sourceRange?.start ?? 0;
      const sourceEndLine = sourceRange?.end ?? 0;
      if ((headingOpen.nesting === 1 || headingOpen.type === 'fence' || headingOpen.type === 'meo_math_block') && sourceLine > 0) {
        headingOpen.attrSet('data-source-line', String(sourceLine));
        headingOpen.attrSet('data-source-end-line', String(Math.max(sourceLine, sourceEndLine)));
      }
      if (headingOpen.type !== 'heading_open') {
        continue;
      }

      const inlineContent = tokens[index + 1];
      const baseSlug = slugifyHeading(inlineContent?.content ?? '') || 'section';
      const occurrence = (slugCounts.get(baseSlug) ?? 0) + 1;
      slugCounts.set(baseSlug, occurrence);
      headingOpen.attrSet('id', occurrence === 1 ? baseSlug : `${baseSlug}-${occurrence}`);

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

function installTableCellListTransform(md: MarkdownIt): void {
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
      inlineNode.children = [htmlNode];
    }
  });
}

function renderBreakSeparatedCellList(content: string, md: MarkdownIt): string | null {
  const lines = content.split(/<br\s*\/?\s*>|\r?\n/gi).filter((line) => line.trim() !== '');
  const items = lines.map((line) => {
    const match = /^([ \t]*)(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
    if (!match) {
      return null;
    }
    const indent = [...match[1]].reduce((columns, char) => columns + (char === '\t' ? 2 : 1), 0);
    return {
      indent,
      type: match[3] ? 'ol' as const : 'ul' as const,
      start: match[3] ? Number.parseInt(match[3], 10) : 1,
      content: match[4]
    };
  });
  if (items.length === 0 || items.some((item) => item === null)) {
    return null;
  }

  let html = '';
  const stack: Array<{ indent: number; type: 'ul' | 'ol'; liOpen: boolean }> = [];
  for (const item of items) {
    if (!item) continue;
    while (stack.length > 0 && item.indent < stack[stack.length - 1].indent) {
      const current = stack.pop()!;
      if (current.liOpen) html += '</li>';
      html += `</${current.type}>`;
    }
    const current = stack[stack.length - 1];
    if (!current || item.indent > current.indent) {
      const start = item.type === 'ol' && item.start !== 1 ? ` start="${item.start}"` : '';
      html += `<${item.type}${start}>`;
      stack.push({ indent: item.indent, type: item.type, liOpen: false });
    } else {
      if (current.liOpen) html += '</li>';
      if (current.type !== item.type) {
        html += `</${current.type}>`;
        stack.pop();
        const start = item.type === 'ol' && item.start !== 1 ? ` start="${item.start}"` : '';
        html += `<${item.type}${start}>`;
        stack.push({ indent: item.indent, type: item.type, liOpen: false });
      }
    }
    html += `<li>${md.renderInline(item.content)}`;
    stack[stack.length - 1].liOpen = true;
  }
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.liOpen) html += '</li>';
    html += `</${current.type}>`;
  }
  return html;
}

function slugifyHeading(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeMarkdownForExport(markdownText: string): string {
  return normalizeMarkdownForExportWithSourceMap(markdownText).markdown;
}

function normalizeMarkdownForExportWithSourceMap(markdownText: string): SourceMappedMarkdown {
  const normalized = normalizeLooseTableDelimiters(normalizeMermaidColonFences(markdownText));
  const expandedLists = expandBreakSeparatedBodyLists(normalized);
  return ensureBlankLinesAroundTableBlocks(expandedLists.markdown, expandedLists.sourceLines);
}

function expandBreakSeparatedBodyLists(markdownText: string): { markdown: string; sourceLines: number[] } {
  const lines = String(markdownText ?? '').split(/\r?\n/);
  const out: string[] = [];
  const sourceLines: number[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = parseFenceLine(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence.char;
        fenceLen = fence.length;
      } else if (fence.char === fenceChar && fence.length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }
    const expanded = !inFence && !line.includes('|')
      ? line.replace(/<br\s*\/?\s*>\s*(?=(?:[-+*]|\d+\.)\s+)/gi, '\n').split('\n')
      : [line];
    for (const expandedLine of expanded) {
      out.push(expandedLine);
      sourceLines.push(index + 1);
    }
  }
  return { markdown: out.join('\n'), sourceLines };
}

function normalizeLooseTableDelimiters(markdownText: string): string {
  const lines = String(markdownText ?? '').split(/\r?\n/);
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const fence = parseFenceLine(lines[index] ?? '');
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence.char;
        fenceLen = fence.length;
      } else if (fence.char === fenceChar && fence.length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }
    if (inFence || index === 0) {
      continue;
    }
    const delimiter = lines[index] ?? '';
    if (!isTableDelimiterLine(delimiter)) {
      continue;
    }
    const headerColumnCount = countTableCells(lines[index - 1] ?? '');
    const delimiterCells = splitTableCells(delimiter);
    if (headerColumnCount <= delimiterCells.length) {
      continue;
    }
    const leadingPipe = delimiter.trimStart().startsWith('|');
    const trailingPipe = delimiter.trimEnd().endsWith('|');
    while (delimiterCells.length < headerColumnCount) {
      delimiterCells.push('---');
    }
    lines[index] = `${leadingPipe ? '| ' : ''}${delimiterCells.join(' | ')}${trailingPipe ? ' |' : ''}`;
  }
  return lines.join('\n');
}

function countTableCells(line: string): number {
  return splitTableCells(line).length;
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function countLeadingIndentColumns(line: string): number {
  const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? '';
  return [...leadingWhitespace].reduce((columns, character) => (
    character === '\t' ? columns + 4 - (columns % 4) : columns + 1
  ), 0);
}

function normalizeMermaidColonFences(markdownText: string): string {
  const lines = String(markdownText ?? '').split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let pendingMermaidBlock: {
    colonCount: number;
    indent: string;
    openingLine: string;
    lines: string[];
  } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (pendingMermaidBlock) {
      if (isMermaidColonFenceCloseLine(line, pendingMermaidBlock.colonCount)) {
        out.push(`${pendingMermaidBlock.indent}\`\`\`mermaid`);
        out.push(...pendingMermaidBlock.lines);
        out.push(`${pendingMermaidBlock.indent}\`\`\``);
        pendingMermaidBlock = null;
        continue;
      }

      pendingMermaidBlock.lines.push(line);
      continue;
    }

    const fence = parseFenceLine(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence.char;
        fenceLen = fence.length;
      } else if (fence.char === fenceChar && fence.length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const mermaidOpen = parseMermaidColonFenceOpenLine(line);
    if (mermaidOpen) {
      pendingMermaidBlock = {
        colonCount: mermaidOpen.colonCount,
        indent: mermaidOpen.indent,
        openingLine: line,
        lines: []
      };
      continue;
    }

    out.push(line);
  }

  if (pendingMermaidBlock) {
    out.push(pendingMermaidBlock.openingLine);
    out.push(...pendingMermaidBlock.lines);
  }

  return out.join('\n');
}

function parseMermaidColonFenceOpenLine(line: string): { indent: string; colonCount: number } | null {
  const match = /^([ \t]{0,3})(:{3,})\s*mermaid\s*$/i.exec(line.trimEnd());
  if (!match) {
    return null;
  }
  return { indent: match[1], colonCount: match[2].length };
}

function isMermaidColonFenceCloseLine(line: string, colonCount: number): boolean {
  if (colonCount < 3) {
    return false;
  }
  return new RegExp(`^[ \\t]{0,3}:{${colonCount},}\\s*$`).test(line.trimEnd());
}

function ensureBlankLinesAroundTableBlocks(
  markdownText: string,
  inputSourceLines: number[]
): { markdown: string; sourceLines: number[] } {
  const lines = String(markdownText ?? '').split(/\r?\n/);
  const out: string[] = [];
  const sourceLines: number[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    const fence = parseFenceLine(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence.char;
        fenceLen = fence.length;
      } else if (fence.char === fenceChar && fence.length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      out.push(line);
      sourceLines.push(inputSourceLines[i] ?? i + 1);
      continue;
    }

    if (inFence) {
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
    const listMarker = /^(?<indent>[ \t]*)(?<marker>[-+*]|\d+\.)\s+/.exec(line);
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

function parseFenceLine(line: string): { char: '`' | '~'; length: number } | null {
  const match = /^[ \t]{0,3}([`~]{3,})/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[1];
  const char = marker[0];
  if (char !== '`' && char !== '~') {
    return null;
  }
  return {
    char,
    length: marker.length
  };
}

function installTaskListTransform(md: MarkdownIt): void {
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

      const match = /^\[([ xX~\-])\]\s+/.exec(token.content ?? '');
      if (!match) {
        continue;
      }

      const statusClass = taskStatusClassFromMarker(match[1]);
      current.token.attrJoin('class', 'meo-export-task-item');
      current.token.attrJoin('class', statusClass);

      removeTaskPrefixFromInlineToken(token, match[0].length);

      const children = Array.isArray(token.children) ? token.children : [];
      const checkboxToken = new state.Token('html_inline', '', 0);
      checkboxToken.content = `<span class="meo-export-task-checkbox ${statusClass}" aria-hidden="true"></span>`;
      const openTextToken = new state.Token('html_inline', '', 0);
      openTextToken.content = `<span class="meo-export-task-text ${statusClass}">`;
      const closeTextToken = new state.Token('html_inline', '', 0);
      closeTextToken.content = '</span>';

      token.children = [checkboxToken, openTextToken, ...children, closeTextToken];
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

function normalizeFenceLanguage(info: string): string {
  const first = `${info ?? ''}`.trim().split(/\s+/, 1)[0] ?? '';
  const normalized = first.toLowerCase();
  return FENCE_LANGUAGE_ALIASES[normalized] ?? normalized;
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

function installAlertTransform(md: MarkdownIt): void {
  const defaultBlockquoteRender = md.renderer.rules.blockquote_open ??
    ((tokens: any, idx: number, opts: any, _env: any, self: any) => self.renderToken(tokens, idx, opts));

  md.renderer.rules.blockquote_open = (tokens: any, idx: number, opts: any, env: any, self: any) => {
    const openToken = tokens[idx];
    let alertType: AlertType | null = null;
    let headerHtml = '';
    const TokenCons = tokens[0].constructor as any;

    for (let i = idx + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type === 'blockquote_close') break;
      if (token.type === 'paragraph_open') continue;
      if (token.type === 'inline' && token.content) {
        const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(token.content.trim());
        if (match) {
          alertType = match[1].toUpperCase() as AlertType;
          headerHtml = [
            '<span class="meo-export-alert-header">',
            `<span class="meo-export-alert-icon">${ALERT_ICONS[alertType]}</span>`,
            `<span class="meo-export-alert-label">${alertType}</span>`,
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

        if (token.children) {
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

        const htmlToken = new TokenCons('html_inline', '', 0);
        htmlToken.content = headerHtml;

        token.children = token.children ?? [];
        token.children.unshift(htmlToken);

        for (const child of token.children) {
          if (child.type === 'text') {
            child.content = child.content.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, '').trimLeft();
            break;
          }
        }

        insertedHeader = true;
      }
    }

    return defaultBlockquoteRender(tokens, idx, opts, env, self);
  };
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
    try {
      return hljs.highlight(code, {
        language,
        ignoreIllegals: true
      }).value;
    } catch {
      // Fallback to escaped plain text.
    }
  }
  return escapeHtml(code);
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
