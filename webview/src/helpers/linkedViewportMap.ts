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
    let previewTotal = 0;
    let count = 0;
    while (index < sorted.length && Math.abs(sorted[index].source - source) <= 0.01) {
      previewTotal += sorted[index].preview;
      count += 1;
      index += 1;
    }
    const previousPreview = points.at(-1)?.preview ?? 0;
    points.push({
      source,
      preview: Math.max(previousPreview, previewTotal / Math.max(1, count))
    });
  }
  if (points.length === 1) points.push({ source: sourceMaximum, preview: previewMaximum });
  points[0] = { source: 0, preview: 0 };
  const last = points.at(-1);
  if (last) points[points.length - 1] = {
    source: sourceMaximum,
    preview: Math.max(last.preview, previewMaximum)
  };
  if (pinnedPoint) {
    const pinned = {
      source: finiteCoordinate(pinnedPoint.source, sourceMaximum),
      preview: finiteCoordinate(pinnedPoint.preview, previewMaximum)
    };
    const withoutSameSource: Array<{ source: number; preview: number }> = points
      .filter(point => Math.abs(point.source - pinned.source) > 0.01)
      .map(point => ({ ...point }));
    for (const point of withoutSameSource) {
      if (point.source < pinned.source && point.preview > pinned.preview) point.preview = pinned.preview;
      if (point.source > pinned.source && point.preview < pinned.preview) point.preview = pinned.preview;
    }
    withoutSameSource.push(pinned);
    withoutSameSource.sort((left, right) => left.source - right.source);
    return withoutSameSource;
  }
  return points;
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
