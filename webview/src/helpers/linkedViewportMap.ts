export type LinkedViewportPoint = {
  readonly source: number;
  readonly preview: number;
};

export type LinkedViewportMap = {
  sourceToPreview(source: number): number;
  previewToSource(preview: number): number;
};

type LinkedViewportMaximums = {
  readonly sourceMaximum: number;
  readonly previewMaximum: number;
};

const finiteCoordinate = (value: number, maximum: number): number => (
  Math.max(0, Math.min(maximum, Number.isFinite(value) ? value : 0))
);

function monotonicPoints(
  input: readonly LinkedViewportPoint[],
  maximums: LinkedViewportMaximums,
  pinnedPoint?: LinkedViewportPoint
): LinkedViewportPoint[] {
  const sourceMaximum = Math.max(0, maximums.sourceMaximum);
  const previewMaximum = Math.max(0, maximums.previewMaximum);
  const sorted = [
    { source: 0, preview: 0 },
    ...input.map(point => ({
      source: finiteCoordinate(point.source, sourceMaximum),
      preview: finiteCoordinate(point.preview, previewMaximum)
    })),
    { source: sourceMaximum, preview: previewMaximum }
  ].sort((left, right) => left.source - right.source || left.preview - right.preview);

  const points: LinkedViewportPoint[] = [];
  for (let index = 0; index < sorted.length;) {
    const source = sorted[index].source;
    const previews: number[] = [];
    while (index < sorted.length && Math.abs(sorted[index].source - source) <= 0.01) {
      previews.push(sorted[index].preview);
      index += 1;
    }
    previews.sort((left, right) => left - right);
    points.push({
      source,
      preview: previews[Math.floor((previews.length - 1) / 2)] ?? 0
    });
  }
  if (points.length === 1) points.push({ source: sourceMaximum, preview: previewMaximum });
  points[0] = { source: 0, preview: 0 };
  const last = points.at(-1);
  if (last) points[points.length - 1] = {
    source: sourceMaximum,
    preview: Math.max(last.preview, previewMaximum)
  };
  const longestNonDecreasingPath = (candidates: readonly LinkedViewportPoint[]): LinkedViewportPoint[] => {
    if (candidates.length <= 2) return [...candidates];
    const tails: number[] = [];
    const tailIndices: number[] = [];
    const previous = Array.from({ length: candidates.length }, () => -1);
    for (let index = 0; index < candidates.length; index += 1) {
      const value = candidates[index].preview;
      let low = 0;
      let high = tails.length;
      // upper_bound keeps equal Preview coordinates. They represent legitimate
      // compact ranges, while a later lower coordinate is an out-of-flow block.
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (tails[middle] <= value) low = middle + 1;
        else high = middle;
      }
      previous[index] = low > 0 ? tailIndices[low - 1] : -1;
      tails[low] = value;
      tailIndices[low] = index;
    }
    const path: LinkedViewportPoint[] = [];
    let index = tailIndices[tails.length - 1] ?? -1;
    while (index >= 0) {
      path.push(candidates[index]);
      index = previous[index];
    }
    path.reverse();
    return path;
  };
  if (pinnedPoint) {
    const pinned = {
      source: finiteCoordinate(pinnedPoint.source, sourceMaximum),
      preview: finiteCoordinate(pinnedPoint.preview, previewMaximum)
    };
    const withoutSameSource: Array<{ source: number; preview: number }> = points
      .filter(point => Math.abs(point.source - pinned.source) > 0.01)
      .map(point => ({ ...point }));
    withoutSameSource.push(pinned);
    withoutSameSource.sort((left, right) => left.source - right.source);
    const pinnedIndex = withoutSameSource.indexOf(pinned);
    const left = longestNonDecreasingPath(withoutSameSource
      .slice(0, pinnedIndex + 1)
      .filter(point => point === pinned || point.preview <= pinned.preview));
    const right = longestNonDecreasingPath(withoutSameSource
      .slice(pinnedIndex)
      .filter(point => point === pinned || point.preview >= pinned.preview));
    return [...left, ...right.slice(1)];
  }
  return longestNonDecreasingPath(points);
}

function project(value: number, points: readonly LinkedViewportPoint[], from: 'source' | 'preview'): number {
  const to = from === 'source' ? 'preview' : 'source';
  const bounded = Math.max(0, Number.isFinite(value) ? value : 0);
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (points[middle][from] <= bounded) low = middle + 1;
    else high = middle - 1;
  }
  const before = points[Math.max(0, high)];
  const after = points[Math.min(points.length - 1, Math.max(0, low))];
  const span = after[from] - before[from];
  if (span <= 0.01) return Math.max(before[to], after[to]);
  const ratio = Math.max(0, Math.min(1, (bounded - before[from]) / span));
  return before[to] + (after[to] - before[to]) * ratio;
}

/** A cached, monotonic projection used by the scroll hot path. */
export function createLinkedViewportMap(
  input: readonly LinkedViewportPoint[],
  maximums: LinkedViewportMaximums,
  pinnedPoint?: LinkedViewportPoint
): LinkedViewportMap {
  const points = monotonicPoints(input, maximums, pinnedPoint);
  const inverse = points
    .map(point => ({ source: point.preview, preview: point.source }))
    .sort((left, right) => left.source - right.source || left.preview - right.preview);
  const inverseMaximums = {
    sourceMaximum: Math.max(0, maximums.previewMaximum),
    previewMaximum: Math.max(0, maximums.sourceMaximum)
  };
  const inversePoints = monotonicPoints(
    inverse,
    inverseMaximums,
    pinnedPoint ? { source: pinnedPoint.preview, preview: pinnedPoint.source } : undefined
  );
  return {
    sourceToPreview: source => project(source, points, 'source'),
    previewToSource: preview => project(preview, inversePoints, 'source')
  };
}
