export type TableColumnWidthPolicyState =
  | { readonly elastic: false; readonly tracksAvailableWidth: false }
  | { readonly elastic: true; readonly tracksAvailableWidth: boolean };

export type TableColumnResizeRequest = {
  readonly widths: readonly number[];
  readonly minimumWidths: readonly number[];
  readonly column: number;
  readonly requestedDelta: number;
  readonly maximumTotalWidth: number;
} & TableColumnWidthPolicyState;

export type TableColumnWidthProjectionRequest = {
  readonly widths: readonly number[];
  readonly minimumWidths: readonly number[];
  readonly initialTotalWidth: number;
  readonly defaultWidthWasCapped: boolean;
  readonly availableWidth: number;
  readonly preserveWidthIntent: boolean;
  readonly maximumTrackedWidth?: number;
} & TableColumnWidthPolicyState;

export type TableColumnWidthResult = {
  readonly widths: readonly number[];
  readonly totalWidth: number;
  readonly reachedAvailableWidth: boolean;
} & TableColumnWidthPolicyState;

export type TableColumnWidthPolicy = {
  resize(request: TableColumnResizeRequest): TableColumnWidthResult;
  project(request: TableColumnWidthProjectionRequest): TableColumnWidthResult;
};

function total(widths: readonly number[]): number {
  return widths.reduce((sum, width) => sum + width, 0);
}

function compressColumns(
  widths: number[],
  minimumWidths: readonly number[],
  from: number,
  to: number,
  requestedCompression: number
): number {
  const indexes = Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset);
  const capacity = indexes.reduce((sum, index) => (
    sum + Math.max(0, widths[index] - minimumWidths[index])
  ), 0);
  const compression = Math.min(Math.max(0, requestedCompression), capacity);
  if (compression <= 0 || indexes.length === 0) return 0;
  const targetTotal = indexes.reduce((sum, index) => sum + widths[index], 0) - compression;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const scale = (low + high) / 2;
    const scaledTotal = indexes.reduce((sum, index) => (
      sum + Math.max(minimumWidths[index], widths[index] * scale)
    ), 0);
    if (scaledTotal > targetTotal) high = scale;
    else low = scale;
  }
  for (const index of indexes) {
    widths[index] = Math.max(minimumWidths[index], widths[index] * low);
  }
  return compression;
}

function requirePolicyState(request: {
  readonly elastic: boolean;
  readonly tracksAvailableWidth: boolean;
}): void {
  if (typeof request.elastic !== 'boolean' || typeof request.tracksAvailableWidth !== 'boolean') {
    throw new TypeError('elastic and tracksAvailableWidth must be explicit booleans');
  }
  if (!request.elastic && request.tracksAvailableWidth) {
    throw new TypeError('a fixed width cannot track the available container width');
  }
}

function policyState(elastic: boolean, tracksAvailableWidth: boolean): TableColumnWidthPolicyState {
  if (!elastic) return { elastic: false, tracksAvailableWidth: false };
  return { elastic: true, tracksAvailableWidth };
}

function resize(request: TableColumnResizeRequest): TableColumnWidthResult {
  requirePolicyState(request);
  const maximumTotalWidth = Math.max(0, request.maximumTotalWidth);
  const minimumTotalWidth = total(request.minimumWidths);
  const infeasibleMaximum = maximumTotalWidth < minimumTotalWidth;
  const startTotalWidth = total(request.widths);
  const baseScale = !infeasibleMaximum && startTotalWidth > maximumTotalWidth && maximumTotalWidth > 0
    ? maximumTotalWidth / startTotalWidth
    : 1;
  const baseWidths = request.widths.map((width, index) => (
    Math.max(infeasibleMaximum ? request.minimumWidths[index] : 0, width * baseScale)
  ));
  const baseTotalWidth = total(baseWidths);
  const baseColumnWidth = baseWidths[request.column];
  const minimumColumnWidth = request.minimumWidths[request.column];
  const minimumDelta = minimumColumnWidth - baseColumnWidth;
  const availableTotalGrowth = Math.max(0, maximumTotalWidth - baseTotalWidth);
  const rightWidths = baseWidths.slice(request.column + 1);
  const rightMinimumWidths = request.minimumWidths.slice(request.column + 1);
  const availableRightCompression = rightWidths.reduce((sum, width, index) => (
    sum + Math.max(0, width - rightMinimumWidths[index])
  ), 0);
  const maximumDelta = infeasibleMaximum
    ? Number.POSITIVE_INFINITY
    : availableTotalGrowth + availableRightCompression;
  const delta = Math.min(maximumDelta, Math.max(minimumDelta, request.requestedDelta));
  const widths = [...baseWidths];
  widths[request.column] = baseColumnWidth + delta;

  const continuedLeftCompression = request.requestedDelta < minimumDelta
    ? minimumDelta - request.requestedDelta
    : 0;
  if (continuedLeftCompression > 0 && request.column > 0) {
    compressColumns(widths, request.minimumWidths, 0, request.column, continuedLeftCompression);
  }

  const compression = infeasibleMaximum ? 0 : Math.max(0, delta - availableTotalGrowth);
  if (compression > 0 && rightWidths.length) {
    compressColumns(widths, request.minimumWidths, request.column + 1, widths.length, compression);
  }

  const totalWidth = total(widths);
  const reachedAvailableWidth = maximumTotalWidth > 0 && totalWidth >= maximumTotalWidth - 1;
  const activeWidthDelta = widths[request.column] - request.widths[request.column];
  const enteredAvailableWidth = activeWidthDelta > 1
    && reachedAvailableWidth
    && startTotalWidth <= maximumTotalWidth + 1;
  const remainsConstrained = reachedAvailableWidth && (request.elastic || infeasibleMaximum);
  const nextTracksAvailableWidth = activeWidthDelta < -1 && !remainsConstrained
    ? false
    : request.tracksAvailableWidth || enteredAvailableWidth || remainsConstrained;
  const nextElastic = activeWidthDelta < -1 && !remainsConstrained
    ? false
    : request.elastic || infeasibleMaximum || (activeWidthDelta > 1 && reachedAvailableWidth);
  return {
    widths,
    totalWidth,
    reachedAvailableWidth,
    ...policyState(nextElastic, nextTracksAvailableWidth)
  };
}

function project(request: TableColumnWidthProjectionRequest): TableColumnWidthResult {
  requirePolicyState(request);
  if (request.minimumWidths.length !== request.widths.length) {
    throw new RangeError('minimumWidths must have the same length as widths');
  }
  if (request.minimumWidths.some((width) => !Number.isFinite(width) || width < 0)) {
    throw new TypeError('minimumWidths must contain only finite non-negative values');
  }
  if (request.preserveWidthIntent) {
    const widths = request.widths.map((width, index) => Math.max(width, request.minimumWidths[index]));
    const totalWidth = total(widths);
    const availableWidth = Math.max(0, request.availableWidth);
    return {
      widths,
      totalWidth,
      reachedAvailableWidth: availableWidth > 0 && totalWidth >= availableWidth - 1,
      ...policyState(request.elastic, request.tracksAvailableWidth)
    };
  }
  const requestedWidths = request.widths.map((width, index) => (
    Math.max(width, request.minimumWidths[index])
  ));
  const requestedTotalWidth = total(requestedWidths);
  const minimumTotalWidth = total(request.minimumWidths);
  const availableWidth = Math.max(0, request.availableWidth);
  const preferredTotalWidth = Math.max(0, request.maximumTrackedWidth
    ?? Math.max(requestedTotalWidth, request.initialTotalWidth));
  const fixedWidthReachedContainer = !request.elastic
    && availableWidth > 0
    && minimumTotalWidth <= availableWidth + 0.5
    && requestedTotalWidth > availableWidth + 0.5;
  const responsive = request.elastic || fixedWidthReachedContainer;
  const targetTotalWidth = responsive
    ? Math.min(availableWidth || preferredTotalWidth, preferredTotalWidth)
    : requestedTotalWidth;
  const constrainedTargetWidth = Math.max(targetTotalWidth, minimumTotalWidth);
  const widths = [...requestedWidths];
  if (requestedTotalWidth > constrainedTargetWidth) {
    compressColumns(
      widths,
      request.minimumWidths,
      0,
      widths.length,
      requestedTotalWidth - constrainedTargetWidth
    );
  } else if (requestedTotalWidth < constrainedTargetWidth) {
    const scale = requestedTotalWidth > 0 ? constrainedTargetWidth / requestedTotalWidth : 0;
    for (let index = 0; index < widths.length; index += 1) {
      widths[index] = requestedTotalWidth > 0
        ? widths[index] * scale
        : constrainedTargetWidth / Math.max(1, widths.length);
    }
  }
  const totalWidth = total(widths);
  const restoredPreferredWidth = request.tracksAvailableWidth
    && availableWidth >= preferredTotalWidth - 0.5
    && totalWidth >= preferredTotalWidth - 0.5;
  const nextState = restoredPreferredWidth
    ? policyState(false, false)
    : fixedWidthReachedContainer
      ? policyState(true, true)
      : policyState(request.elastic, request.tracksAvailableWidth);
  return {
    widths,
    totalWidth,
    reachedAvailableWidth: availableWidth > 0 && totalWidth >= availableWidth - 1,
    ...nextState
  };
}

export const tableColumnWidthPolicy: TableColumnWidthPolicy = { resize, project };
