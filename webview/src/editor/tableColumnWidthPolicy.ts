export type TableColumnResizeRequest = {
  readonly widths: readonly number[];
  readonly minimumWidths: readonly number[];
  readonly column: number;
  readonly requestedDelta: number;
  readonly maximumTotalWidth: number;
};

export type TableColumnWidthProjectionRequest = {
  readonly widths: readonly number[];
  readonly initialTotalWidth: number;
  readonly elastic: boolean;
  readonly defaultWidthWasCapped: boolean;
  readonly availableWidth: number;
};

export type TableColumnWidthResult = {
  readonly widths: readonly number[];
  readonly totalWidth: number;
  readonly reachedAvailableWidth: boolean;
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
  const startTotalWidth = total(request.widths);
  const baseScale = startTotalWidth > maximumTotalWidth && maximumTotalWidth > 0
    ? maximumTotalWidth / startTotalWidth
    : 1;
  const baseWidths = request.widths.map((width) => width * baseScale);
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
  const maximumDelta = availableTotalGrowth + availableRightCompression;
  const delta = Math.min(maximumDelta, Math.max(minimumDelta, request.requestedDelta));
  const widths = [...baseWidths];
  widths[request.column] = baseColumnWidth + delta;

  const compression = Math.max(0, delta - availableTotalGrowth);
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
  return {
    widths,
    totalWidth,
    reachedAvailableWidth: maximumTotalWidth > 0 && totalWidth >= maximumTotalWidth - 1
  };
}

function project(request: TableColumnWidthProjectionRequest): TableColumnWidthResult {
  const requestedTotalWidth = total(request.widths);
  const availableWidth = Math.max(0, request.availableWidth);
  const elasticLimit = request.defaultWidthWasCapped
    ? availableWidth
    : Math.max(requestedTotalWidth, request.initialTotalWidth);
  const targetTotalWidth = Math.min(
    availableWidth || requestedTotalWidth,
    request.elastic ? elasticLimit : requestedTotalWidth
  );
  const scale = requestedTotalWidth > 0 ? targetTotalWidth / requestedTotalWidth : 1;
  const widths = request.widths.map((width) => width * scale);
  const totalWidth = total(widths);
  return {
    widths,
    totalWidth,
    reachedAvailableWidth: availableWidth > 0 && totalWidth >= availableWidth - 1
  };
}

export const tableColumnWidthPolicy: TableColumnWidthPolicy = { resize, project };
