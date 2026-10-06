import path from 'node:path';
import type { SourceMappedMarkdown } from './sourceMappedMarkdown';
import { collectMarkdownCodeLines } from './markdownCodeLines';

export type PrepareMarkdownWithFootnotesOptions = {
  target: 'html' | 'pdf' | 'docx';
  outputFilePath?: string;
  renderMarkdown: (markdownText: string) => string;
  normalizeMarkdown: (markdownText: string) => string;
  backToReference: string;
  backToNumberedReference: (number: number) => string;
  backToReferenceOccurrence: (number: number, occurrence: number) => string;
};

export type PreparedMarkdownWithFootnotes = {
  body: SourceMappedMarkdown;
  footnotesHtml: string;
};

type ExportFootnoteDefinition = {
  normalizedLabel: string;
  number: number | null;
  contentMarkdown: string;
  referenceIds: string[];
  sourceLine: number;
  sourceEndLine: number;
};

const definitionMarkerPattern = /^[ \t]{0,3}\[\^([^\]\r\n]+)\]:(?:[ \t]|$)/;

export function prepareMarkdownWithFootnotes(
  source: SourceMappedMarkdown,
  options: PrepareMarkdownWithFootnotesOptions
): PreparedMarkdownWithFootnotes {
  const extracted = extractExportFootnotes(source);
  const numberByLabel = new Map<string, number>();
  const referenceCountsByLabel = new Map<string, number>();
  const hrefPrefix = getInternalDocumentHrefPrefix(options);
  const pendingDefinitions: ExportFootnoteDefinition[] = [];
  const renderReference = (rawLabel: string): string | null => {
    const normalizedLabel = normalizeFootnoteLabel(rawLabel);
    const definition = extracted.definitionByLabel.get(normalizedLabel);
    if (!definition) {
      return null;
    }

    let footnoteNumber = numberByLabel.get(normalizedLabel);
    if (!footnoteNumber) {
      footnoteNumber = numberByLabel.size + 1;
      numberByLabel.set(normalizedLabel, footnoteNumber);
    }

    const nextCount = (referenceCountsByLabel.get(normalizedLabel) ?? 0) + 1;
    referenceCountsByLabel.set(normalizedLabel, nextCount);
    if (definition.number === null) pendingDefinitions.push(definition);
    definition.number = footnoteNumber;

    const referenceId = nextCount === 1 ? `fnref-${footnoteNumber}` : `fnref-${footnoteNumber}-${nextCount}`;
    definition.referenceIds.push(referenceId);

    return [
      '<sup class="footnote-ref">',
      `<a href="${escapeHtmlAttr(buildInternalAnchorHref(hrefPrefix, `fn-${footnoteNumber}`))}" id="${escapeHtmlAttr(referenceId)}">${footnoteNumber}</a>`,
      '</sup>'
    ].join('');
  };
  const rewriteReferences = (markdown: string): string => {
    const codeLines = collectMarkdownCodeLines(markdown);
    return markdown.split('\n').map((line, index) => (
      codeLines.has(index) ? line : replaceFootnoteReferencesInLine(line, renderReference)
    )).join('\n');
  };
  const bodyLines = rewriteReferences(extracted.bodyLines.join('\n')).split('\n');
  // References inside a definition use the same rules as body text. Each
  // reachable definition is visited once, including cycles and newly cited notes.
  for (let index = 0; index < pendingDefinitions.length; index += 1) {
    const definition = pendingDefinitions[index];
    definition.contentMarkdown = rewriteReferences(definition.contentMarkdown);
  }

  const footnotes = extracted.definitions
    .filter((definition) => definition.number !== null)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  return {
    body: {
      markdown: bodyLines.join('\n'),
      sourceLines: extracted.bodySourceLines
    },
    footnotesHtml: renderFootnotesHtml(footnotes, hrefPrefix, options)
  };
}

function getInternalDocumentHrefPrefix(options: PrepareMarkdownWithFootnotesOptions): string {
  if (options.target !== 'html' || !options.outputFilePath) {
    return '';
  }

  const fileName = path.basename(options.outputFilePath);
  return fileName ? encodeURIComponent(fileName) : '';
}

function extractExportFootnotes(source: SourceMappedMarkdown): {
  bodyLines: string[];
  bodySourceLines: number[];
  definitions: ExportFootnoteDefinition[];
  definitionByLabel: Map<string, ExportFootnoteDefinition>;
} {
  const lines = String(source.markdown ?? '').split(/\r?\n/);
  const consumedLineNumbers = new Set<number>();
  const definitions: ExportFootnoteDefinition[] = [];
  const definitionByLabel = new Map<string, ExportFootnoteDefinition>();
  const codeLines = collectMarkdownCodeLines(source.markdown);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (codeLines.has(index)) {
      continue;
    }

    const markerMatch = definitionMarkerPattern.exec(line);
    if (!markerMatch) {
      continue;
    }

    const normalizedLabel = normalizeFootnoteLabel(markerMatch[1]);
    if (!normalizedLabel || definitionByLabel.has(normalizedLabel)) {
      continue;
    }

    consumedLineNumbers.add(index);
    const definitionStartIndex = index;
    const contentLines = [line.slice(markerMatch[0].length)];
    let continuationBaseline: 2 | 4 | null = null;

    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? '';
      if (definitionMarkerPattern.test(nextLine)) {
        break;
      }
      if (!nextLine.trim()) {
        consumedLineNumbers.add(index + 1);
        contentLines.push('');
        index += 1;
        continue;
      }

      continuationBaseline ??= /^(?: {4}|\t| {1,3}\t)/.test(nextLine) ? 4 : 2;
      const stripped = stripFootnoteContinuationIndent(nextLine, continuationBaseline);
      if (stripped === null) {
        break;
      }

      consumedLineNumbers.add(index + 1);
      contentLines.push(stripped);
      index += 1;
    }

    const definition: ExportFootnoteDefinition = {
      normalizedLabel,
      number: null,
      contentMarkdown: contentLines.join('\n'),
      referenceIds: [],
      sourceLine: source.sourceLines[definitionStartIndex] ?? definitionStartIndex + 1,
      sourceEndLine: source.sourceLines[index] ?? index + 1
    };

    definitions.push(definition);
    definitionByLabel.set(normalizedLabel, definition);
  }

  return {
    bodyLines: lines.filter((_, index) => !consumedLineNumbers.has(index)),
    bodySourceLines: source.sourceLines.filter((_, index) => !consumedLineNumbers.has(index)),
    definitions,
    definitionByLabel
  };
}

function replaceFootnoteReferencesInLine(
  line: string,
  renderReference: (label: string) => string | null
): string {
  if (!line) {
    return line;
  }

  let out = '';
  let index = 0;
  let inCodeSpan = false;
  let codeMarker = '';

  while (index < line.length) {
    const ch = line[index];

    if (ch === '\\' && index + 1 < line.length) {
      out += line.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (ch === '`') {
      let markerEnd = index + 1;
      while (markerEnd < line.length && line[markerEnd] === '`') {
        markerEnd += 1;
      }

      const marker = line.slice(index, markerEnd);
      if (!inCodeSpan) {
        inCodeSpan = true;
        codeMarker = marker;
      } else if (marker === codeMarker) {
        inCodeSpan = false;
        codeMarker = '';
      }
      out += marker;
      index = markerEnd;
      continue;
    }

    if (!inCodeSpan && ch === '[' && line[index + 1] === '^') {
      const closeIndex = line.indexOf(']', index + 2);
      if (closeIndex > index + 2) {
        const rendered = renderReference(line.slice(index + 2, closeIndex));
        if (rendered) {
          out += rendered;
          index = closeIndex + 1;
          continue;
        }
      }
    }

    out += ch;
    index += 1;
  }

  return out;
}

function renderFootnotesHtml(
  footnotes: ExportFootnoteDefinition[],
  hrefPrefix: string,
  options: PrepareMarkdownWithFootnotesOptions
): string {
  if (!footnotes.length) {
    return '';
  }

  const itemsHtml = footnotes.map((footnote) => renderFootnoteItemHtml(footnote, hrefPrefix, options)).join('');
  const sourceLine = Math.min(...footnotes.map((footnote) => footnote.sourceLine));
  const sourceEndLine = Math.max(...footnotes.map((footnote) => footnote.sourceEndLine));
  return [
    `<section class="footnotes" data-source-line="${sourceLine}" data-source-end-line="${sourceEndLine}">`,
    '<hr>',
    '<ol class="footnotes-list">',
    itemsHtml,
    '</ol>',
    '</section>'
  ].join('');
}

function renderFootnoteItemHtml(
  footnote: ExportFootnoteDefinition,
  hrefPrefix: string,
  options: PrepareMarkdownWithFootnotesOptions
): string {
  const number = footnote.number ?? 0;
  const firstReferenceId = footnote.referenceIds[0] ?? '';
  const referenceHref = buildInternalAnchorHref(hrefPrefix, firstReferenceId);
  const contentHtml = options.renderMarkdown(options.normalizeMarkdown(footnote.contentMarkdown)).trim();
  const indexHtml = firstReferenceId
    ? `<a href="${escapeHtmlAttr(referenceHref)}" class="footnote-index" aria-label="${escapeHtmlAttr(options.backToNumberedReference(number))}">${number}.</a>`
    : `<span class="footnote-index">${number}.</span>`;
  const repeated = footnote.referenceIds.length > 1;
  const backlinkHtml = footnote.referenceIds.map((referenceId, index) => {
    const label = repeated ? options.backToReferenceOccurrence(number, index + 1) : options.backToReference;
    const href = escapeHtmlAttr(buildInternalAnchorHref(hrefPrefix, referenceId));
    const suffix = repeated ? '<sup>' + (index + 1) + '</sup>' : '';
    return '<a href="' + href + '" class="footnote-backref" title="' + escapeHtmlAttr(label)
      + '" aria-label="' + escapeHtmlAttr(label) + '">↩' + suffix + '</a>';
  }).join(' ');

  return [
    `<li id="fn-${number}" class="footnote-item" data-source-line="${footnote.sourceLine}" data-source-end-line="${footnote.sourceEndLine}">`,
    indexHtml,
    `<div class="footnote-body">${appendFootnoteBacklink(contentHtml, backlinkHtml)}</div>`,
    '</li>'
  ].join('');
}

function appendFootnoteBacklink(contentHtml: string, backlinkHtml: string): string {
  if (!backlinkHtml) {
    return contentHtml;
  }

  if (contentHtml.endsWith('</p>')) {
    return `${contentHtml.slice(0, -4)} ${backlinkHtml}</p>`;
  }

  return `${contentHtml}${backlinkHtml}`;
}

function buildInternalAnchorHref(prefix: string, fragmentId: string): string {
  return prefix ? `${prefix}#${fragmentId}` : `#${fragmentId}`;
}

function normalizeFootnoteLabel(rawLabel: string): string {
  return String(rawLabel ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function stripFootnoteContinuationIndent(line: string, baseline: 2 | 4): string | null {
  const whitespace = /^[ \t]*/.exec(line)?.[0] ?? '';
  const columns = [...whitespace].reduce((value, ch) => value + (ch === '\t' ? 4 - value % 4 : 1), 0);
  if (columns < 2) return null;
  // Four columns are the normal definition baseline. Accept two-column
  // legacy definitions without consuming the indent of their nested content.
  const consumedBaseline = Math.min(columns, baseline);
  let consumed = 0;
  let offset = 0;
  while (consumed < consumedBaseline) {
    consumed += line[offset] === '\t' ? 4 - consumed % 4 : 1;
    offset += 1;
  }
  return line.slice(offset);
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
