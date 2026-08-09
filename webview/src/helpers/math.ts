import {
  scanLatexMath,
  scanLatexMathAt,
  type LatexMathMode,
  type LatexMathRange
} from '../../../src/shared/latexMathScanner';
import { renderMathToHtml } from '../../../src/shared/mathRenderer';

export type { LatexMathMode, LatexMathRange } from '../../../src/shared/latexMathScanner';

export interface ParseLatexMathAtOptions {
  allowInline?: boolean;
  allowDisplay?: boolean;
}

export interface FencedDisplayMathInnerLineRange {
  innerStartLine: number;
  innerEndLine: number;
}

type SimpleRange = {
  from: number;
  to: number;
};

export function resolveFencedDisplayMathInnerLineRange(
  startLine: number,
  endLine: number
): FencedDisplayMathInnerLineRange | null {
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }

  const innerStartLine = Math.max(1, Math.floor(startLine) + 1);
  const innerEndLine = Math.floor(endLine) - 1;
  if (innerEndLine < innerStartLine) {
    return null;
  }

  return {
    innerStartLine,
    innerEndLine
  };
}

export function parseLatexMathAt(
  text: string,
  index: number,
  options: ParseLatexMathAtOptions = {}
): LatexMathRange | null {
  if (!text || index < 0 || index >= text.length) {
    return null;
  }
  const range = scanLatexMathAt(text, index);
  if (!range) {
    return null;
  }
  if (range.mode === 'inline' && options.allowInline === false) {
    return null;
  }
  if (range.mode === 'display' && options.allowDisplay === false) {
    return null;
  }
  return range;
}

export function collectLatexMathRanges(
  text: string,
  options: {
    baseOffset?: number;
    excludedRanges?: SimpleRange[];
  } = {}
): LatexMathRange[] {
  const { baseOffset = 0, excludedRanges = [] } = options;
  const ranges = scanLatexMath(text, { excludedRanges });
  if (baseOffset === 0) {
    return ranges;
  }
  return ranges.map((range) => ({
    ...range,
    from: range.from + baseOffset,
    to: range.to + baseOffset
  }));
}

export function renderLatexMathToHtml(content: string, mode: LatexMathMode): string | null {
  return renderMathToHtml(content, mode);
}

export function createLatexMathElement(content: string, mode: LatexMathMode): HTMLElement | null {
  const html = renderLatexMathToHtml(content, mode);
  if (!html) {
    return null;
  }

  const wrapper = document.createElement('span');
  wrapper.className = `meo-md-math meo-md-math-${mode}`;
  wrapper.innerHTML = html;
  return wrapper;
}
