export type LargeDocumentDimensions = {
  readonly bytes: number;
  readonly lines: number;
  readonly tables: number;
  readonly mermaid: number;
  readonly images: number;
  readonly math: number;
  readonly richBlocks: number;
  readonly codeFences: number;
};

export type LargeDocumentAssessment = {
  readonly dimensions: LargeDocumentDimensions;
  readonly pressure: number;
  readonly preferSource: boolean;
  /** Rendering can need a bounded work budget before startup should prefer Source. */
  readonly boundedEditorWork: boolean;
};

// These reference budgets are calibrated by the Phase I production benchmark.
const REFERENCE_BYTES = 300_000;
const REFERENCE_LINES = 8_000;
const REFERENCE_RICH_BLOCKS = 256;

/** Cheap proof using the same size budgets. A UTF-16 length may be passed as a
 * lower bound for UTF-8 bytes when the caller must not scan a changing document. */
export function exceedsLargeDocumentTextBudget(minimumBytes: number, lines: number): boolean {
  return minimumBytes / REFERENCE_BYTES + lines / REFERENCE_LINES >= 1;
}

const countMatches = (text: string, pattern: RegExp): number => {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
};

const countLines = (text: string): number => {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
};

/** Pure text assessment shared by Host startup policy and the Editor work budget. */
export function assessLargeDocument(text: string): LargeDocumentAssessment {
  const tables = countMatches(text, /^\|\s*:?-{3,}.*\|\s*$/gmu);
  const mermaid = countMatches(text, /^```mermaid\s*$/gmu);
  const images = countMatches(text, /!\[[^\]\r\n]*\]\([^\r\n]+\)/gu);
  const displayMathDelimiters = countMatches(text, /^\$\$\s*$/gmu);
  const math = Math.floor(displayMathDelimiters / 2);
  const codeFences = countMatches(text, /^[ \t]*(?:>[ \t]*)*(?:`{3,}|~{3,})[ \t]*[^\s`~]+[^\r\n]*$/gmu);
  const dimensions: LargeDocumentDimensions = {
    bytes: new TextEncoder().encode(text).byteLength,
    lines: countLines(text),
    tables,
    mermaid,
    images,
    math,
    richBlocks: tables + mermaid + images + math,
    codeFences
  };
  const pressure = dimensions.bytes / REFERENCE_BYTES
    + dimensions.lines / REFERENCE_LINES
    + dimensions.richBlocks / REFERENCE_RICH_BLOCKS;
  // Native acceptance found whole-presentation work already expensive in a
  // 14 KiB document with 100 tables/fences. Preserve its normal opening policy
  // and Source palette, but start bounding presentation at a quarter budget.
  return { dimensions, pressure, preferSource: pressure >= 1,
    boundedEditorWork: pressure >= 0.25 || codeFences >= 48 };
}
