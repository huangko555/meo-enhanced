type SourceRange = { readonly from: number; readonly to: number };

/** Reuses one ordered index for repeated containment/overlap checks, including nested ranges. */
export function indexSourceRanges(ranges: readonly SourceRange[], mode: 'contains' | 'overlaps' = 'contains'): (from: number, to: number) => boolean {
  const overlap = mode === 'overlaps';
  const ordered = [...ranges].sort((left, right) => left.from - right.from);
  const maximumEnds: number[] = [];
  let maximumEnd = -Infinity;
  for (const range of ordered) {
    maximumEnd = Math.max(maximumEnd, range.to);
    maximumEnds.push(maximumEnd);
  }
  return (from, to) => {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (overlap ? ordered[middle]!.from < to : ordered[middle]!.from <= from) low = middle + 1;
      else high = middle;
    }
    return low > 0 && (overlap ? maximumEnds[low - 1]! > from : maximumEnds[low - 1]! >= to);
  };
}
