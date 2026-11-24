type FoldedRange = { foldedFrom: number; foldedTo: number; sourceFrom: number; sourceTo: number };
export type TextSearchCursor = () => { start: number; end: number } | null;

function foldLowercase(text: string): string {
  // Treat explicitly dotted I the same in composed and decomposed text.
  return text.replaceAll('i\u0307', 'i');
}

function resizedRanges(source: string, locale?: string): FoldedRange[] {
  const ranges: FoldedRange[] = [];
  let adjustment = 0;
  // Only dotted-I and Lithuanian/Turkic special casing resize a lowercase
  // cluster. Contextual final sigma is kept by folding whole text.
  for (const cluster of source.matchAll(/[İÌÍĨ]\p{M}*|[IJĮi]\p{M}+/gu)) {
    const text = cluster[0];
    const foldedLength = foldLowercase(text.toLocaleLowerCase(locale)).length;
    if (foldedLength === text.length) continue;
    const sourceFrom = cluster.index!;
    const foldedFrom = sourceFrom + adjustment;
    ranges.push({ foldedFrom, foldedTo: foldedFrom + foldedLength, sourceFrom, sourceTo: sourceFrom + text.length });
    adjustment += foldedLength - text.length;
  }
  return ranges;
}

function sourceOffset(ranges: readonly FoldedRange[], offset: number, end: boolean): number {
  let from = 0;
  let to = ranges.length;
  while (from < to) {
    const mid = (from + to) >>> 1;
    if (ranges[mid]!.foldedFrom <= offset) from = mid + 1;
    else to = mid;
  }
  const range = ranges[from - 1];
  if (!range) return offset;
  if (offset === range.foldedFrom) return range.sourceFrom;
  if (offset < range.foldedTo) return end ? range.sourceTo : range.sourceFrom;
  return range.sourceTo + offset - range.foldedTo;
}

/** Prepare a query, then find non-overlapping matches lazily in source coordinates. */
export function createTextSearch(query: string, caseSensitive = false, locale?: string): (text: string) => TextSearchCursor {
  const needle = caseSensitive ? query : foldLowercase(query.toLocaleLowerCase(locale));
  return (text: string) => {
    const lower = caseSensitive ? text : text.toLocaleLowerCase(locale);
    const comparable = caseSensitive ? text : foldLowercase(lower);
    const ranges = lower.length === text.length && comparable === lower ? [] : resizedRanges(text, locale);
    let offset = 0;
    let previousEnd = 0;
    return () => {
      if (!needle) return null;
      for (;;) {
        const found = comparable.indexOf(needle, offset);
        if (found < 0) return null;
        offset = found + needle.length;
        const start = sourceOffset(ranges, found, false);
        const end = sourceOffset(ranges, offset, true);
        if (start < previousEnd) continue;
        previousEnd = end;
        return { start, end };
      }
    };
  };
}
