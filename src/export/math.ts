import {
  scanLatexMath,
  scanLatexMathAt,
  type LatexMathMode,
  type LatexMathRange,
  type LatexMathScanOptions
} from '../shared/latexMathScanner';
import { renderMathToHtml } from '../shared/mathRenderer';

export type { LatexMathMode, LatexMathRange } from '../shared/latexMathScanner';

export function collectLatexMathRanges(text: string, options: LatexMathScanOptions = {}): LatexMathRange[] {
  return scanLatexMath(text, options);
}

export function parseLatexMathAt(text: string, from: number, options: LatexMathScanOptions = {}): LatexMathRange | null {
  return scanLatexMathAt(text, from, options);
}

export function renderLatexMathToHtml(content: string, mode: LatexMathMode): string | null {
  return renderMathToHtml(content, mode);
}

/** Preview can postpone display formulas until their reading band is visible.
 * Keep copy source separate: optional fence wrappers and whitespace are not
 * necessarily the expression passed to the renderer. */
export function renderLatexMathPresentation(content: string, mode: LatexMathMode, deferDisplay = false): { html: string; attributes: string } | null {
  if (deferDisplay && mode === 'display' && content.trim()) {
    return {
      html: content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      attributes: ` data-meo-deferred-math="${Buffer.from(content, 'utf8').toString('base64')}"`
    };
  }
  const html = renderLatexMathToHtml(content, mode);
  return html === null ? null : { html, attributes: '' };
}
