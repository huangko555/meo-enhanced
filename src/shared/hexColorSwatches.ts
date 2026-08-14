export type HexColorRange = {
  from: number;
  to: number;
  value: string;
};

export type HexColorScanRange = {
  from: number;
  to: number;
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

function scanQuoted(text: string, start: number, quote: string, scanTo: number): number {
  let cursor = start + 1;
  while (cursor < scanTo) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return scanTo;
}

function scanFunction(text: string, openIndex: number, scanTo: number): number {
  let depth = 1;
  let cursor = openIndex + 1;
  while (cursor < scanTo) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      cursor = scanQuoted(text, cursor, character, scanTo);
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
  return scanTo;
}

interface BacktickRun {
  from: number;
  to: number;
  length: number;
}

interface DelimiterSummary {
  codeEndByStart: ReadonlyMap<number, number>;
  linkEndByOpen: ReadonlyMap<number, number>;
}

function collectBacktickRuns(text: string, scanFrom: number, scanTo: number): BacktickRun[] {
  const runs: BacktickRun[] = [];
  let precedingSlashes = 0;
  let cursor = scanFrom;
  while (cursor < scanTo) {
    if (text[cursor] === '\n') {
      precedingSlashes = 0;
      cursor += 1;
      continue;
    }
    if (text[cursor] === '\\') {
      precedingSlashes += 1;
      cursor += 1;
      continue;
    }
    if (text[cursor] !== '`') {
      precedingSlashes = 0;
      cursor += 1;
      continue;
    }
    const from = cursor;
    while (cursor < scanTo && text[cursor] === '`') cursor += 1;
    const escapedPrefixLength = precedingSlashes % 2 === 1 ? 1 : 0;
    const delimiterFrom = from + escapedPrefixLength;
    if (delimiterFrom < cursor) {
      runs.push({ from: delimiterFrom, to: cursor, length: cursor - delimiterFrom });
    }
    precedingSlashes = 0;
  }
  return runs;
}

function collectDelimiterSummary(text: string, scanFrom: number, scanTo: number): DelimiterSummary {
  const runs = collectBacktickRuns(text, scanFrom, scanTo);
  const nextRunByLength = new Map<number, number>();
  const nextMatchingRun = new Array<number>(runs.length).fill(-1);
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    nextMatchingRun[index] = nextRunByLength.get(runs[index].length) ?? -1;
    nextRunByLength.set(runs[index].length, index);
  }

  const codeEndByStart = new Map<number, number>();
  const codeRanges: ExcludedRange[] = [];
  for (let index = 0; index < runs.length;) {
    const closeIndex = nextMatchingRun[index];
    if (closeIndex < 0) {
      index += 1;
      continue;
    }
    const range = { from: runs[index].from, to: runs[closeIndex].to };
    codeRanges.push(range);
    codeEndByStart.set(range.from, range.to);
    index = closeIndex + 1;
  }

  const matchingParenthesisEnd = new Map<number, number>();
  const openParentheses: number[] = [];
  let codeIndex = 0;
  let precedingSlashes = 0;
  for (let cursor = scanFrom; cursor < scanTo; cursor += 1) {
    const codeRange = codeRanges[codeIndex];
    if (codeRange && cursor === codeRange.from) {
      cursor = codeRange.to - 1;
      codeIndex += 1;
      precedingSlashes = 0;
      continue;
    }
    const character = text[cursor];
    if (character === '\\') {
      precedingSlashes += 1;
      continue;
    }
    const escaped = precedingSlashes % 2 === 1;
    precedingSlashes = 0;
    if (escaped) continue;
    if (character === '(') openParentheses.push(cursor);
    else if (character === ')') {
      const open = openParentheses.pop();
      if (open !== undefined) matchingParenthesisEnd.set(open, cursor + 1);
    }
  }

  const linkEndByOpen = new Map<number, number>();
  for (const [open, to] of matchingParenthesisEnd) {
    if (text[open - 1] === ']') linkEndByOpen.set(open, to);
  }
  return { codeEndByStart, linkEndByOpen };
}

function scanHtmlTag(text: string, start: number, scanTo: number): number {
  let cursor = start + 1;
  while (cursor < scanTo) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      cursor = scanQuoted(text, cursor, character, scanTo);
      continue;
    }
    if (character === '>') return cursor + 1;
    cursor += 1;
  }
  return scanTo;
}

function scanAbsoluteUrl(text: string, start: number, scanTo: number): number {
  let cursor = start;
  while (cursor < scanTo && !/[\s<>]/.test(text[cursor])) cursor += 1;
  return cursor;
}

/** Builds sorted, non-overlapping ranges that cannot own standalone swatches. */
function collectExcludedRanges(text: string, scanFrom: number, scanTo: number): ExcludedRange[] {
  const ranges: ExcludedRange[] = [];
  const delimiters = collectDelimiterSummary(text, scanFrom, scanTo);
  let cursor = scanFrom;

  while (cursor < scanTo) {
    const codeEnd = delimiters.codeEndByStart.get(cursor);
    if (codeEnd !== undefined) {
      ranges.push({ from: cursor, to: codeEnd });
      cursor = codeEnd;
      continue;
    }

    if (text[cursor] === '<' && /[a-z!/]/i.test(text[cursor + 1] ?? '')) {
      const to = scanHtmlTag(text, cursor, scanTo);
      ranges.push({ from: cursor, to });
      cursor = to;
      continue;
    }

    const previous = cursor > 0 ? text[cursor - 1] : '';
    const scheme = text.substring(cursor, Math.min(cursor + 8, scanTo)).toLowerCase();
    const startsAbsoluteUrl = scheme.startsWith('http://') || scheme.startsWith('https://');
    const startsProtocolRelativeUrl = text.startsWith('//', cursor);
    if (!/[\w-]/.test(previous) && (startsAbsoluteUrl || startsProtocolRelativeUrl)) {
      const to = scanAbsoluteUrl(text, cursor, scanTo);
      ranges.push({ from: cursor, to });
      cursor = to;
      continue;
    }

    if (text[cursor] === ']' && text[cursor + 1] === '(') {
      const to = delimiters.linkEndByOpen.get(cursor + 1);
      if (to !== undefined) {
        ranges.push({ from: cursor + 1, to });
        cursor = to;
        continue;
      }
    }

    if (/[a-z]/i.test(text[cursor]) && !/[\w-]/.test(previous)) {
      let nameEnd = cursor + 1;
      while (nameEnd < scanTo && /[\w-]/.test(text[nameEnd] ?? '')) nameEnd += 1;
      let openIndex = nameEnd;
      while (openIndex < scanTo && /\s/.test(text[openIndex] ?? '')) openIndex += 1;
      const functionName = text.substring(cursor, nameEnd).toLowerCase();
      if (text[openIndex] === '(' && excludedFunctionNames.has(functionName)) {
        const to = scanFunction(text, openIndex, scanTo);
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

/** Finds standalone HEX color literals in one source range without changing the source text. */
export function collectHexColorRangesFromText(
  text: string,
  offset = 0,
  scanRange: Readonly<HexColorScanRange> = { from: 0, to: text.length }
): HexColorRange[] {
  const scanFrom = Math.max(0, Math.min(text.length, Math.trunc(scanRange.from)));
  const scanTo = Math.max(scanFrom, Math.min(text.length, Math.trunc(scanRange.to)));
  const ranges: HexColorRange[] = [];
  const excludedRanges = collectExcludedRanges(text, scanFrom, scanTo);
  let excludedIndex = 0;

  HEX_COLOR_REGEX.lastIndex = scanFrom;
  for (let match = HEX_COLOR_REGEX.exec(text); match !== null; match = HEX_COLOR_REGEX.exec(text)) {
    const value = match[0];
    const from = match.index;
    if (from >= scanTo) break;
    while (excludedRanges[excludedIndex]?.to <= from) excludedIndex += 1;
    const isExcluded = excludedRanges[excludedIndex]?.from <= from;
    if (from + value.length > scanTo
      || ![4, 5, 7, 9].includes(value.length)
      || !isColorBoundary(text, from, value)
      || isExcluded) {
      continue;
    }
    ranges.push({ from: from + offset, to: from + value.length + offset, value });
  }

  return ranges;
}
