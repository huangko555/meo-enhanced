export type InitialEditorMode = 'live' | 'source' | 'preview';

export type LargeDocumentDimensions = {
  readonly bytes: number;
  readonly lines: number;
  readonly tables: number;
  readonly mermaid: number;
  readonly images: number;
  readonly math: number;
  readonly richBlocks: number;
};

export type LargeDocumentAssessment = {
  readonly dimensions: LargeDocumentDimensions;
  readonly pressure: number;
  readonly preferSource: boolean;
};

type InitialEditorModeInput = {
  readonly text: string;
  readonly persistedMode: InitialEditorMode | null;
  readonly optimizationEnabled: boolean;
};

// The reference budgets are calibrated by the Phase I production benchmark. Combining
// normalized dimensions prevents one representation of document size from owning policy.
const REFERENCE_BYTES = 300_000;
const REFERENCE_LINES = 8_000;
const REFERENCE_RICH_BLOCKS = 256;

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

export function assessLargeDocument(text: string): LargeDocumentAssessment {
  const tables = countMatches(text, /^\|\s*:?-{3,}.*\|\s*$/gmu);
  const mermaid = countMatches(text, /^```mermaid\s*$/gmu);
  const images = countMatches(text, /!\[[^\]\r\n]*\]\([^\r\n]+\)/gu);
  const displayMathDelimiters = countMatches(text, /^\$\$\s*$/gmu);
  const math = Math.floor(displayMathDelimiters / 2);
  const dimensions: LargeDocumentDimensions = {
    bytes: new TextEncoder().encode(text).byteLength,
    lines: countLines(text),
    tables,
    mermaid,
    images,
    math,
    richBlocks: tables + mermaid + images + math
  };
  const pressure = dimensions.bytes / REFERENCE_BYTES
    + dimensions.lines / REFERENCE_LINES
    + dimensions.richBlocks / REFERENCE_RICH_BLOCKS;
  return { dimensions, pressure, preferSource: pressure >= 1 };
}

/** Selects the initial mode only; later user intent remains owned by EditorModeApplication. */
export function selectInitialEditorMode(input: InitialEditorModeInput): InitialEditorMode {
  if (input.persistedMode !== null) return input.persistedMode;
  if (!input.optimizationEnabled) return 'live';
  return assessLargeDocument(input.text).preferSource ? 'source' : 'live';
}
