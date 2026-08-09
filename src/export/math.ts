import {
  scanLatexMath,
  type LatexMathMode,
  type LatexMathRange
} from '../shared/latexMathScanner';
import { renderMathToHtml } from '../shared/mathRenderer';

export type { LatexMathMode, LatexMathRange } from '../shared/latexMathScanner';

export function collectLatexMathRanges(text: string): LatexMathRange[] {
  return scanLatexMath(text);
}

export function renderLatexMathToHtml(content: string, mode: LatexMathMode): string | null {
  return renderMathToHtml(content, mode);
}
