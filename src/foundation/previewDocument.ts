export type PreviewDocumentBlock = Readonly<{
  index: number;
  sourceLine: number;
  sourceEndLine: number;
  kind: string;
  sourceCharacters: number;
  sourceRanges?: readonly Readonly<{ start: number; end: number }>[];
}>;

export type PreviewDocumentHeading = Readonly<{ text: string; level: number; line: number; id: string }>;
export type PreviewDocumentChunk = Readonly<{ index: number; html: string; hasMermaid: boolean }>;
export type PreviewCodeSource = Readonly<{ id: string; language: string; source: string }>;
export type PreviewDocumentManifest = Readonly<{
  id: string;
  anchorLine: number;
  blocks: readonly PreviewDocumentBlock[];
  headings: readonly PreviewDocumentHeading[];
  chunks: readonly PreviewDocumentChunk[];
  codeSources?: readonly PreviewCodeSource[];
}>;

export type PreviewDocumentPosition = Readonly<{ block: number; offset: number }>;
export type PreviewDocumentMatch = PreviewDocumentPosition & Readonly<{
  end: number; line: number; occurrence: number; index: number;
}>;
export type PreviewDocumentOperation =
  | { readonly kind: 'blocks'; readonly indices: readonly number[] }
  | { readonly kind: 'locate'; readonly sourceLine?: number; readonly anchor?: string }
  | { readonly kind: 'search'; readonly query: string; readonly caseSensitive: boolean;
      readonly wholeWord: boolean; readonly selectIndex?: number; readonly anchor?: { readonly line: number; readonly occurrence: number } }
  | { readonly kind: 'copy'; readonly from: PreviewDocumentPosition; readonly to: PreviewDocumentPosition };

export type PreviewDocumentResult =
  | { readonly kind: 'blocks'; readonly chunks: readonly PreviewDocumentChunk[] }
  | { readonly kind: 'locate'; readonly block: number | null }
  | { readonly kind: 'search'; readonly total: number; readonly active: PreviewDocumentMatch | null;
      readonly blocks: readonly [index: number, count: number][] }
  | { readonly kind: 'copy'; readonly text: string; readonly html: string };

/** Exact navigation retains footnote identity; continuous reading skips definitions relocated from the body. */
export function previewBlockAtLine(blocks: readonly PreviewDocumentBlock[], line: number, readingFlow = false): number | null {
  if (!blocks.length) return null;
  let bodyEnd = blocks.length;
  while (bodyEnd > 0 && blocks[bodyEnd - 1]!.kind === 'footnotes') bodyEnd -= 1;
  const bodyLastLine = bodyEnd > 0 ? blocks[bodyEnd - 1]!.sourceEndLine : 0;
  let previousNote: { index: number; end: number } | null = null;
  for (let index = bodyEnd; index < blocks.length; index += 1) {
    if (readingFlow && blocks[index]!.sourceLine < bodyLastLine) continue;
    for (const range of blocks[index]!.sourceRanges ?? []) {
      if (line >= range.start && line <= range.end) return index;
      if (range.end < line && (!previousNote || range.end > previousNote.end)) previousNote = { index, end: range.end };
    }
  }
  let low = 0, high = bodyEnd;
  while (low < high) { const middle = (low + high) >>> 1;
    if (blocks[middle]!.sourceLine <= line) low = middle + 1; else high = middle; }
  const index = Math.max(0, low - 1);
  return previousNote && (bodyEnd === 0 || previousNote.end > blocks[index]!.sourceEndLine) ? previousNote.index : index;
}
