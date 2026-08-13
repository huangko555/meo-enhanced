export type HexColorRange = {
  from: number;
  to: number;
  value: string;
};

const HEX_COLOR_REGEX = /#[0-9a-f]{3,8}/gi;
const excludedFunctionPattern = /(?:^|[^\w-])((?:repeating-)?(?:linear|radial|conic)-gradient|url)\s*\(/gi;

function isColorBoundary(text: string, index: number, value: string): boolean {
  const previous = index > 0 ? text[index - 1] : '';
  const next = text[index + value.length] ?? '';

  if (/[\w#\\/-]/.test(previous) || /[\w#/-]/.test(next)) {
    return false;
  }
  if (previous === '(' && /\]\s*$/.test(text.slice(0, index - 1))) {
    return false;
  }
  return true;
}

function isInsideExcludedCssFunction(text: string, index: number): boolean {
  excludedFunctionPattern.lastIndex = 0;
  for (const match of text.slice(0, index).matchAll(excludedFunctionPattern)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    for (let cursor = openIndex + 1; cursor < index; cursor += 1) {
      if (text[cursor] === '(') depth += 1;
      else if (text[cursor] === ')') depth -= 1;
    }
    if (depth > 0) return true;
  }
  return false;
}

/** Finds standalone HEX color literals without changing the source text. */
export function collectHexColorRangesFromText(text: string, offset = 0): HexColorRange[] {
  const ranges: HexColorRange[] = [];

  for (const match of text.matchAll(HEX_COLOR_REGEX)) {
    const value = match[0];
    const from = match.index ?? 0;
    if (![4, 5, 7, 9].includes(value.length)
      || !isColorBoundary(text, from, value)
      || isInsideExcludedCssFunction(text, from)) {
      continue;
    }
    ranges.push({ from: from + offset, to: from + value.length + offset, value });
  }

  return ranges;
}
