export type TableColumnResizeRequest = {
  readonly widths: readonly number[];
  readonly minimumWidths: readonly number[];
  readonly elastic: boolean;
  readonly column: number;
  readonly requestedDelta: number;
  readonly maximumTotalWidth: number;
};

export type TableColumnWidthProjectionRequest = {
  readonly widths: readonly number[];
  readonly minimumWidths: readonly number[];
  readonly initialTotalWidth: number;
  readonly elastic: boolean;
  readonly defaultWidthWasCapped: boolean;
  readonly availableWidth: number;
  readonly preserveWidthIntent: boolean;
};

export type TableColumnWidthResult = {
  readonly widths: readonly number[];
  readonly totalWidth: number;
  readonly reachedAvailableWidth: boolean;
  readonly elastic: boolean;
};

export type TableColumnWidthPolicy = {
  resize(request: TableColumnResizeRequest): TableColumnWidthResult;
  project(request: TableColumnWidthProjectionRequest): TableColumnWidthResult;
};

function total(widths: readonly number[]): number {
  return widths.reduce((sum, width) => sum + width, 0);
}

function resize(request: TableColumnResizeRequest): TableColumnWidthResult {
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

  const compression = infeasibleMaximum ? 0 : Math.max(0, delta - availableTotalGrowth);
  if (compression > 0 && rightWidths.length) {
    const targetRightTotal = total(rightWidths) - compression;
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const scale = (low + high) / 2;
      const scaledTotal = rightWidths.reduce((sum, width, index) => (
        sum + Math.max(rightMinimumWidths[index], width * scale)
      ), 0);
      if (scaledTotal > targetRightTotal) high = scale;
      else low = scale;
    }
    for (let index = 0; index < rightWidths.length; index += 1) {
      widths[request.column + index + 1] = Math.max(
        rightMinimumWidths[index],
        rightWidths[index] * low
      );
    }
  }

  const totalWidth = total(widths);
  const reachedAvailableWidth = maximumTotalWidth > 0 && totalWidth >= maximumTotalWidth - 1;
  const activeWidthDelta = widths[request.column] - request.widths[request.column];
  return {
    widths,
    totalWidth,
    reachedAvailableWidth,
    elastic: activeWidthDelta < -1
      ? false
      : request.elastic || (activeWidthDelta > 1 && reachedAvailableWidth)
  };
}

function project(request: TableColumnWidthProjectionRequest): TableColumnWidthResult {
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
      elastic: request.elastic
    };
  }
  const requestedTotalWidth = total(request.widths);
  const availableWidth = Math.max(0, request.availableWidth);
  const elasticLimit = request.defaultWidthWasCapped
    ? availableWidth
    : Math.max(requestedTotalWidth, request.initialTotalWidth);
  const targetTotalWidth = Math.min(
    availableWidth || requestedTotalWidth,
    request.elastic ? elasticLimit : requestedTotalWidth
  );
  const minimumTotalWidth = total(request.minimumWidths);
  const constrainedTargetWidth = Math.max(targetTotalWidth, minimumTotalWidth);
  const elasticities = request.widths.map((width, index) => (
    Math.max(0, width - request.minimumWidths[index])
  ));
  const totalElasticity = total(elasticities);
  const distributableWidth = constrainedTargetWidth - minimumTotalWidth;
  const fallbackWeightTotal = total(request.widths);
  const widths = request.minimumWidths.map((minimumWidth, index) => (
    minimumWidth + distributableWidth * (totalElasticity > 0
      ? elasticities[index] / totalElasticity
      : fallbackWeightTotal > 0
        ? request.widths[index] / fallbackWeightTotal
        : 1 / request.widths.length)
  ));
  const totalWidth = total(widths);
  return {
    widths,
    totalWidth,
    reachedAvailableWidth: availableWidth > 0 && totalWidth >= availableWidth - 1,
    elastic: request.elastic
  };
}

export const tableColumnWidthPolicy: TableColumnWidthPolicy = { resize, project };
