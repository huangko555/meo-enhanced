export type LargeDocumentDimensions = {
  readonly bytes: number;
  readonly lines: number;
  readonly tables: number;
  readonly mermaid: number;
  readonly images: number;
  readonly math: number;
  readonly richBlocks: number;
  readonly codeFences: number;
  readonly maxLineLength: number;
  readonly maxCodeBlockLength: number;
  readonly maxTableRows: number;
};

export type LargeDocumentAssessment = {
  readonly dimensions: LargeDocumentDimensions;
  readonly pressure: number;
  readonly preferSource: boolean;
  /** Rendering can need a bounded work budget before startup should prefer Source. */
  readonly boundedEditorWork: boolean;
  readonly lightweightSourceSyntax: boolean;
  readonly windowedPreview: boolean;
};

// Initial structural reference budgets, checked by the production strategy
// comparison. They are guardrails, not universal latency boundaries.
const REFERENCE_BYTES = 300_000;
const REFERENCE_LINES = 8_000;
const REFERENCE_RICH_BLOCKS = 256;
// Preview has to create reading DOM for fences as well as rich resources.
// Keep this admission independent of opening mode and Source syntax budgets.
const PREVIEW_BLOCK_BUDGET = 128;

/** Cheap proof using the same size budgets. A UTF-16 length may be passed as a
 * lower bound for UTF-8 bytes when the caller must not scan a changing document. */
export function exceedsLargeDocumentTextBudget(minimumBytes: number, lines: number): boolean {
  return minimumBytes / REFERENCE_BYTES + lines / REFERENCE_LINES >= 1;
}

type FenceRange = { from: number; to: number };
const countMatches = (text: string, pattern: RegExp, excluded: readonly FenceRange[]): number => {
  let count = 0, cursor = 0;
  for (const match of text.matchAll(pattern)) {
    while (cursor < excluded.length && excluded[cursor]!.to <= match.index) cursor++;
    if (cursor === excluded.length || match.index < excluded[cursor]!.from) count++;
  }
  return count;
};

const lineDimensions = (text: string): { lines: number; maxLineLength: number } => {
  let lines = 1, start = 0, maxLineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      maxLineLength = Math.max(maxLineLength, index - start - (text.charCodeAt(index - 1) === 13 ? 1 : 0));
      lines++; start = index + 1;
    }
  }
  return { lines, maxLineLength: Math.max(maxLineLength, text.length - start) };
};

/** Pure text assessment shared by Host startup policy and the Editor work budget. */
export function assessLargeDocument(text: string): LargeDocumentAssessment {
  const excluded: FenceRange[] = [];
  let opened: { marker: string; from: number } | undefined;
  let codeFences = 0, mermaid = 0, fencedMath = 0, maxCodeBlockLength = 0;
  // Count actual opening/closing pairs, including unlabeled and tilde fences.
  // An enclosing Markdown example owns its contents; nested examples and rich
  // markers inside literal code must not be mistaken for rendered resources.
  for (const match of text.matchAll(/^[ \t]*(?:>[ \t]*)*(?:[-+*][ \t]+|\d+[.)][ \t]+)?(`{3,}|~{3,})([^\r\n]*)$/gmu)) {
    const marker = match[1]!, info = match[2]!.trim();
    if (opened) {
      if (marker[0] !== opened.marker[0] || marker.length < opened.marker.length || info) continue;
      const to = match.index + match[0].length;
      excluded.push({ from: opened.from, to });
      maxCodeBlockLength = Math.max(maxCodeBlockLength, to - opened.from); opened = undefined;
    } else {
      if (marker[0] === '`' && info.includes('`')) continue;
      opened = { marker, from: match.index }; codeFences++;
      const language = info.split(/[ \t]/, 1)[0]!.toLowerCase();
      if (language === 'mermaid') mermaid++;
      if (language === 'math' || language === 'latex' || language === 'tex') fencedMath++;
    }
  }
  if (opened) {
    excluded.push({ from: opened.from, to: text.length });
    maxCodeBlockLength = Math.max(maxCodeBlockLength, text.length - opened.from);
  }
  const tableDelimiter = /^(?! {4}| {0,3}\t)[ \t]*(?=[|:-])(?=[^\r\n]*\|)\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/gmu;
  const tables = countMatches(text, tableDelimiter, excluded);
  let maxTableRows = 0, fenceIndex = 0, tableBodyTo = 0;
  for (const match of text.matchAll(tableDelimiter)) {
    // Delimiter-shaped cell contents are still rows of the current table.
    // Do not scan their common suffix again (quadratic for a long such table).
    if (match.index < tableBodyTo) continue;
    while (fenceIndex < excluded.length && excluded[fenceIndex]!.to <= match.index) fenceIndex++;
    if (fenceIndex < excluded.length && match.index >= excluded[fenceIndex]!.from) continue;
    let from = text.indexOf('\n', match.index), rows = 0;
    while (from >= 0 && ++from < text.length) {
      const end = text.indexOf('\n', from), line = text.slice(from, end < 0 ? text.length : end);
      if (!line.trim() || !line.includes('|')) break;
      rows++; from = end;
    }
    maxTableRows = Math.max(maxTableRows, rows);
    tableBodyTo = from < 0 ? text.length : from;
  }
  const images = countMatches(text, /!\[[^\]\r\n]*\]\([^\r\n]+\)/gu, excluded);
  const displayMathDelimiters = countMatches(text, /^\$\$\s*$/gmu, excluded);
  const math = fencedMath + Math.floor(displayMathDelimiters / 2);
  const dimensions: LargeDocumentDimensions = {
    bytes: new TextEncoder().encode(text).byteLength,
    ...lineDimensions(text),
    tables,
    mermaid,
    images,
    math,
    richBlocks: tables + mermaid + images + math,
    codeFences,
    maxCodeBlockLength,
    maxTableRows
  };
  const pressure = dimensions.bytes / REFERENCE_BYTES
    + dimensions.lines / REFERENCE_LINES
    + dimensions.richBlocks / REFERENCE_RICH_BLOCKS;
  const previewBlocks = dimensions.richBlocks + codeFences - mermaid - fencedMath;
  // Short rich documents also need bounded presentation work. Preserve their
  // ordinary opening policy and Source palette at the earlier work threshold.
  // One long table can be expensive even in a short file. The optional opening
  // preference covers that case without lowering Source coloring. Preview can
  // now partition a giant Markdown table into independent source-backed bands.
  return { dimensions, pressure, preferSource: pressure >= 1 || maxTableRows >= 1_024,
    lightweightSourceSyntax: pressure >= 1,
    windowedPreview: pressure >= 1 || maxTableRows >= 1024 || previewBlocks >= PREVIEW_BLOCK_BUDGET,
    boundedEditorWork: pressure >= 0.25 || codeFences >= 48 || maxTableRows >= 512 };
}
