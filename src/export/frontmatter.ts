import { sliceSourceMappedMarkdown, type SourceMappedMarkdown } from './sourceMappedMarkdown';
import {
  findYamlMappingSeparator,
  isYamlFrontmatterValid,
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
  kind: 'property' | 'list-item' | 'raw';
  html: string;
};

type RenderedFrontmatterProperty = {
  keyHtml: string;
  valueHtml: string;
  hasValue: boolean;
};

type FrontmatterValueKind = 'string' | 'number' | 'literal' | 'link' | 'comment';

export function extractExportFrontmatter(source: SourceMappedMarkdown, propertiesLabel: string): ExtractedExportFrontmatter {
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
  if (!isYamlFrontmatterValid(lines.slice(1, closingLineIndex).join('\n'))) {
    return {
      frontmatterHtml: renderInvalidFrontmatterSourceHtml(
        lines.slice(0, closingLineIndex + 1),
        source.sourceLines[0] ?? 1,
        source.sourceLines[closingLineIndex] ?? closingLineIndex + 1
      ),
      body: sliceSourceMappedMarkdown(source, closingLineIndex + 1)
    };
  }

  return {
    frontmatterHtml: renderFrontmatterHtml(
      lines.slice(1, closingLineIndex),
      source.sourceLines[0] ?? 1,
      source.sourceLines[closingLineIndex] ?? closingLineIndex + 1,
      propertiesLabel
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

function renderFrontmatterHtml(contentLines: string[], sourceLine: number, sourceEndLine: number, propertiesLabel: string): string {
  const renderedBlocks: string[] = [];
  for (let index = 0; index < contentLines.length;) {
    const line = contentLines[index] ?? '';
    const property = yamlIndentationWidth(line) === 0
      ? renderFrontmatterPropertyParts(line)
      : null;
    if (!property) {
      const renderedLine = renderFrontmatterLineHtml(line);
      renderedBlocks.push(
        `<div class="meo-export-frontmatter-line is-${renderedLine.kind}">${renderedLine.html || '&nbsp;'}</div>`
      );
      index += 1;
      continue;
    }

    const continuationLines: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < contentLines.length) {
      const nextLine = contentLines[nextIndex] ?? '';
      if (nextLine.trim().length > 0 && yamlIndentationWidth(nextLine) === 0) break;
      continuationLines.push(nextLine);
      nextIndex += 1;
    }
    const primaryValue = property.hasValue
      ? `<div class="meo-export-frontmatter-value-line is-primary">${property.valueHtml}</div>`
      : '';
    const continuationValues = continuationLines.map(renderFrontmatterContinuationHtml).join('');
    const emptyValue = !primaryValue && !continuationValues ? '&nbsp;' : '';
    renderedBlocks.push([
      '<div class="meo-export-frontmatter-line is-property">',
      property.keyHtml,
      `<div class="meo-export-frontmatter-value-group">${primaryValue}${continuationValues}${emptyValue}</div>`,
      '</div>'
    ].join(''));
    index = nextIndex;
  }
  const linesHtml = renderedBlocks.join('');

  return [
    `<section class="meo-export-frontmatter" data-source-line="${sourceLine}" data-source-end-line="${sourceEndLine}">`,
    `<div class="meo-export-frontmatter-header"><span class="meo-export-frontmatter-header-icon" aria-hidden="true"></span><span>${escapeHtml(propertiesLabel)}</span></div>`,
    linesHtml,
    '</section>'
  ].join('');
}

function renderInvalidFrontmatterSourceHtml(lines: string[], sourceLine: number, sourceEndLine: number): string {
  return [
    `<pre class="meo-export-frontmatter-source" data-source-line="${sourceLine}" data-source-end-line="${sourceEndLine}">`,
    `<code>${escapeHtml(lines.join('\n'))}</code>`,
    '</pre>'
  ].join('');
}

function renderFrontmatterLineHtml(line: string): RenderedFrontmatterLine {
  const property = renderFrontmatterPropertyParts(line);
  if (!property) {
    const listItem = parseYamlScalarListItem(line);
    if (listItem) {
      return {
        kind: 'list-item',
        html: [
          `<span class="meo-export-frontmatter-list-prefix" aria-hidden="true">${escapeHtml(listItem.prefix)}</span>`,
          renderFrontmatterValueHtml(listItem.value)
        ].join('')
      };
    }
    return { kind: 'raw', html: escapeHtml(line) };
  }

  return {
    kind: 'property',
    html: `${property.keyHtml}${property.valueHtml}`
  };
}

function renderFrontmatterPropertyParts(line: string): RenderedFrontmatterProperty | null {
  const offsets = yamlFrontmatterFieldOffsets(line);
  if (!offsets) return null;
  const beforeKey = line.slice(0, offsets.keyFromOffset);
  const key = line.slice(offsets.keyFromOffset, offsets.keyToOffset - 1).trimEnd();
  const value = offsets.valueFromOffset === null ? '' : line.slice(offsets.valueFromOffset);
  const arrayItems = parseSimpleYamlFlowArrayItems(line, offsets.valueFromOffset);
  return {
    keyHtml: [
      '<span class="meo-export-frontmatter-key-cell">',
      beforeKey ? `<span class="meo-export-frontmatter-prefix" aria-hidden="true">${escapeHtml(beforeKey)}</span>` : '',
      `<span class="meo-export-frontmatter-key">${escapeHtml(key)}</span>`,
      '</span>'
    ].join(''),
    valueHtml: arrayItems
      ? `<span class="meo-export-frontmatter-value is-string">${renderFrontmatterArrayHtml(arrayItems)}</span>`
      : renderFrontmatterValueHtml(value),
    hasValue: value.length > 0
  };
}

function renderFrontmatterContinuationHtml(line: string): string {
  if (line.trim().length === 0) {
    return '<div class="meo-export-frontmatter-value-line is-empty">&nbsp;</div>';
  }
  const listItem = parseYamlScalarListItem(line);
  if (listItem) {
    return [
      '<div class="meo-export-frontmatter-value-line is-list-item">',
      '<span class="meo-export-frontmatter-list-prefix" aria-hidden="true">•&nbsp;</span>',
      renderFrontmatterValueHtml(listItem.value),
      '</div>'
    ].join('');
  }
  return `<div class="meo-export-frontmatter-value-line is-raw">${escapeHtml(line)}</div>`;
}

function parseYamlScalarListItem(line: string): { prefix: string; value: string } | null {
  const match = /^(\s*-\s+)(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  return { prefix: match[1], value: match[2] };
}

function renderFrontmatterValueHtml(value: string): string {
  const kind = classifyFrontmatterValue(value);
  return `<span class="meo-export-frontmatter-value is-${kind}">${value ? escapeHtml(value) : '&nbsp;'}</span>`;
}

function classifyFrontmatterValue(value: string): FrontmatterValueKind {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    return 'comment';
  }
  if (/^(?:true|false|null|~)$/i.test(trimmed)) {
    return 'literal';
  }
  if (/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(trimmed)) {
    return 'number';
  }
  if (/^(?:https?:\/\/|mailto:)/i.test(trimmed) || /^\[\[[\s\S]+\]\]$/.test(trimmed)) {
    return 'link';
  }
  return 'string';
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
