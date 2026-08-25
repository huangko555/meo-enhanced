export type LatexMathMode = 'inline' | 'display';

export type LatexMathRange = {
  from: number;
  to: number;
  mode: LatexMathMode;
  content: string;
  raw: string;
  fencedDisplay?: boolean;
};

export type LatexMathScanOptions = {
  /** Half-open input ranges whose contents do not participate in delimiter matching. */
  excludedRanges?: ReadonlyArray<Readonly<{ from: number; to: number }>>;
};

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

const INLINE_MATH_MARKDOWN_STRUCTURE_MARKERS = Object.freeze(['**', '__', '~~', '`', '](', '![']);
const INLINE_MATH_PROSE_LENGTH_LIMIT = 120;
const INLINE_MATH_CURRENCY_CONTENT_RE = /^[0-9][0-9\s,._%+-]*$/;
const INLINE_MATH_TEX_COMMAND_RE = /\\[A-Za-z]+/;
const INLINE_MATH_TEX_SYMBOL_RE = /[_^{}]/;

function shouldRejectInlineMathCandidate(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || INLINE_MATH_CURRENCY_CONTENT_RE.test(trimmed)) {
    return true;
  }
  if (INLINE_MATH_MARKDOWN_STRUCTURE_MARKERS.some((marker) => content.includes(marker))) {
    return true;
  }
  const hasTexCue = INLINE_MATH_TEX_COMMAND_RE.test(content) || INLINE_MATH_TEX_SYMBOL_RE.test(content);
  if (!hasTexCue && trimmed.length > INLINE_MATH_PROSE_LENGTH_LIMIT) {
    return true;
  }
  if (!hasTexCue && (content.match(/\b[A-Za-z]{3,}\b/g)?.length ?? 0) >= 2) {
    return true;
  }
  return false;
}

type SourceRange = { from: number; to: number };

function normalizeExcludedRanges(
  ranges: ReadonlyArray<Readonly<SourceRange>>
): SourceRange[] {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from)
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const normalized: SourceRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (!previous || range.from > previous.to) {
      normalized.push(range);
    } else if (range.to > previous.to) {
      previous.to = range.to;
    }
  }
  return normalized;
}

function excludedRangeAt(ranges: ReadonlyArray<SourceRange>, index: number): SourceRange | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (index < range.from) {
      high = middle - 1;
    } else if (index >= range.to) {
      low = middle + 1;
    } else {
      return range;
    }
  }
  return null;
}

function findInlineMathClose(text: string, start: number, excludedRanges: ReadonlyArray<SourceRange>): number {
  let braceLevel = 0;
  for (let index = start; index < text.length; index += 1) {
    const excluded = excludedRangeAt(excludedRanges, index);
    if (excluded) {
      index = excluded.to - 1;
      continue;
    }
    const character = text[index];
    if (character === '\n' || character === '\r') {
      return -1;
    }
    if (character === '$' && !isEscaped(text, index) && braceLevel === 0) {
      return index;
    }
    if (character === '\\') {
      index += 1;
    } else if (character === '{') {
      braceLevel += 1;
    } else if (character === '}' && braceLevel > 0) {
      braceLevel -= 1;
    }
  }
  return -1;
}

function findDisplayMathClose(text: string, start: number, excludedRanges: ReadonlyArray<SourceRange>): number {
  let braceLevel = 0;
  for (let index = start; index < text.length - 1; index += 1) {
    const excluded = excludedRangeAt(excludedRanges, index);
    if (excluded) {
      index = excluded.to - 1;
      continue;
    }
    const character = text[index];
    if (character === '$' && text[index + 1] === '$' && !isEscaped(text, index) && braceLevel === 0) {
      return index;
    }
    if (character === '\\') {
      index += 1;
    } else if (character === '{') {
      braceLevel += 1;
    } else if (character === '}' && braceLevel > 0) {
      braceLevel -= 1;
    }
  }
  return -1;
}

type LatexMathCandidate = {
  range: LatexMathRange | null;
  nextOpen: number;
};

function scanLatexMathCandidateAt(
  text: string,
  open: number,
  excludedRanges: ReadonlyArray<SourceRange>
): LatexMathCandidate {
  const excluded = excludedRangeAt(excludedRanges, open);
  if (excluded) {
    return { range: null, nextOpen: excluded.to };
  }
  if (text[open] !== '$' || isEscaped(text, open)) {
    return { range: null, nextOpen: open + 1 };
  }
  if (text[open + 1] === '$') {
    const close = findDisplayMathClose(text, open + 2, excludedRanges);
    if (close <= open + 2) {
      return { range: null, nextOpen: open + 2 };
    }
    const rawContent = text.slice(open + 2, close);
    const content = rawContent.trim();
    if (!content) {
      return { range: null, nextOpen: close + 2 };
    }
    const openLineStart = text.lastIndexOf('\n', Math.max(0, open - 1)) + 1;
    const openLineEnd = text.indexOf('\n', open + 2);
    const closeLineStart = text.lastIndexOf('\n', Math.max(0, close - 1)) + 1;
    const closeLineEnd = text.indexOf('\n', close + 2);
    const fencedDisplay = !text.slice(openLineStart, open).trim()
      && !text.slice(open + 2, openLineEnd < 0 ? text.length : openLineEnd).trim()
      && !text.slice(closeLineStart, close).trim()
      && !text.slice(close + 2, closeLineEnd < 0 ? text.length : closeLineEnd).trim();
    if ((rawContent.includes('\n') || rawContent.includes('\r')) && !fencedDisplay) {
      return { range: null, nextOpen: close + 2 };
    }
    return {
      range: {
        from: open,
        to: close + 2,
        mode: 'display',
        content,
        raw: text.slice(open, close + 2),
        fencedDisplay
      },
      nextOpen: close + 2
    };
  }
  if (!text[open + 1] || isWhitespace(text[open + 1])) {
    return { range: null, nextOpen: open + 1 };
  }
  const close = findInlineMathClose(text, open + 1, excludedRanges);
  if (close <= open + 1 || isWhitespace(text[close - 1])) {
    return { range: null, nextOpen: open + 1 };
  }
  const content = text.slice(open + 1, close);
  if (shouldRejectInlineMathCandidate(content)) {
    return { range: null, nextOpen: open + 1 };
  }
  return {
    range: {
      from: open,
      to: close + 1,
      mode: 'inline',
      content,
      raw: text.slice(open, close + 1)
    },
    nextOpen: close + 1
  };
}

/** Returns the LaTeX range that starts exactly at `index`, if any. */
export function scanLatexMathAt(
  text: string,
  index: number,
  options: LatexMathScanOptions = {}
): LatexMathRange | null {
  if (!text || index < 0 || index >= text.length) {
    return null;
  }
  return scanLatexMathCandidateAt(
    text,
    index,
    normalizeExcludedRanges(options.excludedRanges ?? [])
  ).range;
}

/**
 * Scans LaTeX ranges in source order. Returned positions are relative to `text`;
 * malformed or non-math dollar-delimited prose is left unrecognized.
 */
export function scanLatexMath(text: string, options: LatexMathScanOptions = {}): LatexMathRange[] {
  const excludedRanges = normalizeExcludedRanges(options.excludedRanges ?? []);
  const ranges: LatexMathRange[] = [];
  for (let open = 0; open < text.length;) {
    const candidate = scanLatexMathCandidateAt(text, open, excludedRanges);
    if (candidate.range) {
      ranges.push(candidate.range);
    }
    open = candidate.nextOpen;
  }
  return ranges;
}
