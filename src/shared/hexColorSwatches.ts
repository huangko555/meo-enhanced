export type HexColorRange = {
  from: number;
  to: number;
  value: string;
};

const HEX_COLOR_REGEX = /#[0-9a-f]{3,8}/gi;
const excludedFunctionNames = new Set([
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'url'
]);

interface ExcludedRange {
  from: number;
  to: number;
}

function scanQuoted(text: string, start: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

function scanFunction(text: string, openIndex: number): number {
  let depth = 1;
  let cursor = openIndex + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      cursor = scanQuoted(text, cursor, character);
      continue;
    }
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function scanBacktickCode(text: string, start: number): number | null {
  if (isEscaped(text, start)) return null;
  let markerLength = 1;
  while (text[start + markerLength] === '`') markerLength += 1;
  let cursor = start + markerLength;
  while (cursor < text.length) {
    if (text[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    let closingLength = 1;
    while (text[cursor + closingLength] === '`') closingLength += 1;
    if (closingLength === markerLength) return cursor + closingLength;
    cursor += closingLength;
  }
  // CommonMark treats an unmatched inline marker as ordinary text. Fenced
  // blocks remain owned by the consumers' Markdown syntax/token layers.
  return null;
}

function scanHtmlTag(text: string, start: number): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      cursor = scanQuoted(text, cursor, character);
      continue;
    }
    if (character === '>') return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

function scanAbsoluteUrl(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && !/[\s<>]/.test(text[cursor])) cursor += 1;
  return cursor;
}

function scanMarkdownLinkDestination(text: string, openIndex: number): number | null {
  let depth = 1;
  let cursor = openIndex + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text[cursor] === '(') depth += 1;
    if (text[cursor] === ')' && --depth === 0) return cursor + 1;
    cursor += 1;
  }
  return null;
}

/** Builds sorted, non-overlapping ranges that cannot own standalone swatches. */
function collectExcludedRanges(text: string): ExcludedRange[] {
  const ranges: ExcludedRange[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] === '`') {
      const to = scanBacktickCode(text, cursor);
      if (to !== null) {
        ranges.push({ from: cursor, to });
        cursor = to;
        continue;
      }
      cursor += 1;
      continue;
    }

    if (text[cursor] === '<' && /[a-z!/]/i.test(text[cursor + 1] ?? '')) {
      const to = scanHtmlTag(text, cursor);
      ranges.push({ from: cursor, to });
      cursor = to;
      continue;
    }

    const previous = cursor > 0 ? text[cursor - 1] : '';
    const scheme = text.substring(cursor, cursor + 8).toLowerCase();
    const startsAbsoluteUrl = scheme.startsWith('http://') || scheme.startsWith('https://');
    const startsProtocolRelativeUrl = text.startsWith('//', cursor);
    if (!/[\w-]/.test(previous) && (startsAbsoluteUrl || startsProtocolRelativeUrl)) {
      const to = scanAbsoluteUrl(text, cursor);
      ranges.push({ from: cursor, to });
      cursor = to;
      continue;
    }

    if (text[cursor] === ']' && text[cursor + 1] === '(') {
      const to = scanMarkdownLinkDestination(text, cursor + 1);
      if (to !== null) {
        ranges.push({ from: cursor + 1, to });
        cursor = to;
        continue;
      }
    }

    if (/[a-z]/i.test(text[cursor]) && !/[\w-]/.test(previous)) {
      let nameEnd = cursor + 1;
      while (/[\w-]/.test(text[nameEnd] ?? '')) nameEnd += 1;
      let openIndex = nameEnd;
      while (/\s/.test(text[openIndex] ?? '')) openIndex += 1;
      const functionName = text.substring(cursor, nameEnd).toLowerCase();
      if (text[openIndex] === '(' && excludedFunctionNames.has(functionName)) {
        const to = scanFunction(text, openIndex);
        ranges.push({ from: cursor, to });
        cursor = to;
        continue;
      }
      cursor = nameEnd;
      continue;
    }

    cursor += 1;
  }

  return ranges;
}

function isColorBoundary(text: string, index: number, value: string): boolean {
  const previous = index > 0 ? text[index - 1] : '';
  const next = text[index + value.length] ?? '';

  if (/[\w#\\/-]/.test(previous) || /[\w#/-]/.test(next)) {
    return false;
  }
  if (previous === '(') {
    let cursor = index - 2;
    while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
    if (text[cursor] === ']') return false;
  }
  return true;
}

/** Finds standalone HEX color literals without changing the source text. */
export function collectHexColorRangesFromText(text: string, offset = 0): HexColorRange[] {
  const ranges: HexColorRange[] = [];
  const excludedRanges = collectExcludedRanges(text);
  let excludedIndex = 0;

  for (const match of text.matchAll(HEX_COLOR_REGEX)) {
    const value = match[0];
    const from = match.index ?? 0;
    while (excludedRanges[excludedIndex]?.to <= from) excludedIndex += 1;
    const isExcluded = excludedRanges[excludedIndex]?.from <= from;
    if (![4, 5, 7, 9].includes(value.length)
      || !isColorBoundary(text, from, value)
      || isExcluded) {
      continue;
    }
    ranges.push({ from: from + offset, to: from + value.length + offset, value });
  }

  return ranges;
}
