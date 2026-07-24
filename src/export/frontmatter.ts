import { sliceSourceMappedMarkdown, type SourceMappedMarkdown } from './sourceMappedMarkdown';
import {
  findYamlMappingSeparator,
  isYamlBlockScalarValue,
  yamlIndentationWidth
} from '../shared/yamlFrontmatter';

export type ExtractedExportFrontmatter = {
  frontmatterHtml: string;
  body: SourceMappedMarkdown;
};

type YamlFieldOffsets = {
  keyFromOffset: number;
  keyToOffset: number;
  valueFromOffset: number | null;
};

type YamlArrayItem = {
  text: string;
};

type RenderedFrontmatterLine = {
  kind: 'property' | 'raw';
  html: string;
};

export function extractExportFrontmatter(source: SourceMappedMarkdown): ExtractedExportFrontmatter {
  const lines = String(source.markdown ?? '').split(/\r?\n/);
  if (lines.length < 2) {
    return { frontmatterHtml: '', body: source };
  }

  const firstLine = stripLeadingBom(lines[0] ?? '');
  if (firstLine.trim() !== '---') {
    return { frontmatterHtml: '', body: source };
  }

  const closingLineIndex = findFrontmatterClosingLine(lines);
  if (closingLineIndex < 1) {
    return { frontmatterHtml: '', body: source };
  }

  return {
    frontmatterHtml: renderFrontmatterHtml(
      lines.slice(1, closingLineIndex),
      source.sourceLines[0] ?? 1,
      source.sourceLines[closingLineIndex] ?? closingLineIndex + 1
    ),
    body: sliceSourceMappedMarkdown(source, closingLineIndex + 1)
  };
}

function findFrontmatterClosingLine(lines: string[]): number {
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      return index;
    }
  }

  return -1;
}

function renderFrontmatterHtml(contentLines: string[], sourceLine: number, sourceEndLine: number): string {
  let blockScalarParentIndent: number | null = null;
  const linesHtml = contentLines.map((line) => {
    const indentation = yamlIndentationWidth(line);
    const isBlank = line.trim().length === 0;
    const isBlockScalarContent = blockScalarParentIndent !== null
      && (isBlank || indentation > blockScalarParentIndent);
    if (blockScalarParentIndent !== null && !isBlockScalarContent) {
      blockScalarParentIndent = null;
    }

    const renderedLine = isBlockScalarContent
      ? { kind: 'raw' as const, html: escapeHtml(line) }
      : renderFrontmatterLineHtml(line);
    if (!isBlockScalarContent && isYamlBlockScalarHeader(line)) {
      blockScalarParentIndent = indentation;
    }
    return `<div class="meo-export-frontmatter-line is-${renderedLine.kind}">${renderedLine.html || '&nbsp;'}</div>`;
  }).join('');

  return [
    `<section class="meo-export-frontmatter" data-source-line="${sourceLine}" data-source-end-line="${sourceEndLine}">`,
    '<div class="meo-export-frontmatter-header"><span class="meo-export-frontmatter-header-icon" aria-hidden="true"></span><span>Properties</span></div>',
    linesHtml,
    '</section>'
  ].join('');
}

function isYamlBlockScalarHeader(line: string): boolean {
  const offsets = yamlFrontmatterFieldOffsets(line);
  if (offsets?.valueFromOffset === null || offsets?.valueFromOffset === undefined) {
    return false;
  }
  return isYamlBlockScalarValue(line.slice(offsets.valueFromOffset));
}

function renderFrontmatterLineHtml(line: string): RenderedFrontmatterLine {
  const offsets = yamlFrontmatterFieldOffsets(line);
  if (!offsets) {
    return { kind: 'raw', html: escapeHtml(line) };
  }

  const beforeKey = line.slice(0, offsets.keyFromOffset);
  const key = line.slice(offsets.keyFromOffset, offsets.keyToOffset - 1).trimEnd();
  const value = offsets.valueFromOffset === null ? '' : line.slice(offsets.valueFromOffset);
  const arrayItems = parseSimpleYamlFlowArrayItems(line, offsets.valueFromOffset);

  return {
    kind: 'property',
    html: [
      '<span class="meo-export-frontmatter-key-cell">',
      beforeKey ? `<span class="meo-export-frontmatter-prefix" aria-hidden="true">${escapeHtml(beforeKey)}</span>` : '',
      `<span class="meo-export-frontmatter-key">${escapeHtml(key)}</span>`,
      '</span>',
      '<span class="meo-export-frontmatter-value">',
      arrayItems ? renderFrontmatterArrayHtml(arrayItems) : (value ? escapeHtml(value) : '&nbsp;'),
      '</span>'
    ].join('')
  };
}

function renderFrontmatterArrayHtml(items: YamlArrayItem[]): string {
  const pills = items
    .map((item) => `<span class="meo-export-frontmatter-pill">${escapeHtml(item.text)}</span>`)
    .join('');
  return `<span class="meo-export-frontmatter-array">${pills}</span>`;
}

function yamlFrontmatterFieldOffsets(lineText: string): YamlFieldOffsets | null {
  let offset = 0;
  while (offset < lineText.length && (lineText[offset] === ' ' || lineText[offset] === '\t')) {
    offset += 1;
  }

  if (lineText[offset] === '-' && /\s/.test(lineText[offset + 1] ?? '')) {
    offset += 1;
    while (offset < lineText.length && (lineText[offset] === ' ' || lineText[offset] === '\t')) {
      offset += 1;
    }
  }

  if (offset >= lineText.length || lineText[offset] === '#') {
    return null;
  }

  const colonOffset = findYamlMappingSeparator(lineText, offset);
  if (colonOffset < 0) {
    return null;
  }

  let keyEndOffset = colonOffset;
  while (keyEndOffset > offset && (lineText[keyEndOffset - 1] === ' ' || lineText[keyEndOffset - 1] === '\t')) {
    keyEndOffset -= 1;
  }
  if (keyEndOffset <= offset) {
    return null;
  }

  let valueStartOffset = colonOffset + 1;
  while (
    valueStartOffset < lineText.length &&
    (lineText[valueStartOffset] === ' ' || lineText[valueStartOffset] === '\t')
  ) {
    valueStartOffset += 1;
  }

  return {
    keyFromOffset: offset,
    keyToOffset: colonOffset + 1,
    valueFromOffset: valueStartOffset < lineText.length ? valueStartOffset : null
  };
}

function parseSimpleYamlFlowArrayItems(lineText: string, valueFromOffset: number | null): YamlArrayItem[] | null {
  if (
    valueFromOffset === null ||
    valueFromOffset < 0 ||
    valueFromOffset >= lineText.length ||
    lineText[valueFromOffset] !== '['
  ) {
    return null;
  }

  let arrayToOffset = lineText.length;
  while (arrayToOffset > valueFromOffset && (lineText[arrayToOffset - 1] === ' ' || lineText[arrayToOffset - 1] === '\t')) {
    arrayToOffset -= 1;
  }

  if (arrayToOffset <= valueFromOffset + 1 || lineText[arrayToOffset - 1] !== ']') {
    return null;
  }

  const innerFromOffset = valueFromOffset + 1;
  const innerToOffset = arrayToOffset - 1;
  if (innerToOffset <= innerFromOffset) {
    return null;
  }

  for (let index = innerFromOffset; index < innerToOffset; index += 1) {
    const ch = lineText[index];
    if (ch === '"' || ch === '\'' || ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      return null;
    }
  }

  const items: YamlArrayItem[] = [];
  let partFromOffset = innerFromOffset;
  for (let index = innerFromOffset; index <= innerToOffset; index += 1) {
    const atEnd = index === innerToOffset;
    if (!atEnd && lineText[index] !== ',') {
      continue;
    }

    let itemFromOffset = partFromOffset;
    let itemToOffset = index;
    while (itemFromOffset < itemToOffset && (lineText[itemFromOffset] === ' ' || lineText[itemFromOffset] === '\t')) {
      itemFromOffset += 1;
    }
    while (itemToOffset > itemFromOffset && (lineText[itemToOffset - 1] === ' ' || lineText[itemToOffset - 1] === '\t')) {
      itemToOffset -= 1;
    }

    if (itemFromOffset >= itemToOffset) {
      return null;
    }

    items.push({ text: lineText.slice(itemFromOffset, itemToOffset) });
    partFromOffset = index + 1;
  }

  return items.length ? items : null;
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
