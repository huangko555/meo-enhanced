const DEFAULT_MINIMUM_COLUMN_WIDTH = 90;
const preferredWidthCache = new WeakMap<HTMLTableElement, {
  readonly signature: string;
  readonly widths: readonly number[];
}>();

export type PreviewTableWidthPlan = {
  readonly widths: readonly number[];
  readonly totalWidth: number;
  readonly overflows: boolean;
};

export function planPreviewTableWidths(
  preferredWidths: readonly number[],
  availableWidth: number,
  minimumColumnWidth = DEFAULT_MINIMUM_COLUMN_WIDTH
): PreviewTableWidthPlan {
  if (preferredWidths.length === 0) return { widths: [], totalWidth: 0, overflows: false };
  const available = Math.max(0, availableWidth);
  const minimum = Math.max(1, minimumColumnWidth);
  const minimumTotal = minimum * preferredWidths.length;
  const totalWidth = available;
  const preferredCap = Math.max(minimum, Math.min(640, Math.max(360, available * 0.62)));
  if (available < minimumTotal) {
    // The minimum is a readability target, not an overflow trigger. Preserve a
    // small equal share for every column, then distribute the remaining width
    // by measured content demand so the table always converges on its container.
    const equalBudget = available * 0.35;
    const equalShare = equalBudget / preferredWidths.length;
    const demands = preferredWidths.map(width => Math.max(
      1,
      Math.min(preferredCap, Number.isFinite(width) ? width : minimum)
    ));
    const demandTotal = demands.reduce((sum, demand) => sum + demand, 0);
    const weightedBudget = Math.max(0, available - equalBudget);
    const widths = demands.map(demand => equalShare + weightedBudget * (demand / demandTotal));
    return { widths, totalWidth, overflows: false };
  }
  const demands = preferredWidths.map((width) => (
    Math.max(0, Math.min(preferredCap, Number.isFinite(width) ? width : minimum) - minimum)
  ));
  const widths = preferredWidths.map(() => minimum);
  let remaining = Math.max(0, totalWidth - minimumTotal);
  let active = demands.map((demand, index) => ({ demand, index })).filter(({ demand }) => demand > 0.5);

  // Water-fill toward each column's measured max-content width. Columns with
  // more content receive more room, while short columns retain a readable floor.
  while (remaining > 0.5 && active.length > 0) {
    const demandTotal = active.reduce((sum, entry) => sum + entry.demand, 0);
    if (demandTotal <= 0) break;
    let consumed = 0;
    const next: typeof active = [];
    for (const entry of active) {
      const allocation = Math.min(entry.demand, remaining * (entry.demand / demandTotal));
      widths[entry.index] += allocation;
      consumed += allocation;
      const demand = entry.demand - allocation;
      if (demand > 0.5) next.push({ ...entry, demand });
    }
    if (consumed <= 0.1) break;
    remaining -= consumed;
    active = next;
  }

  if (remaining > 0) {
    const extra = remaining / widths.length;
    for (let index = 0; index < widths.length; index += 1) widths[index] += extra;
  }
  return { widths, totalWidth, overflows: false };
}

export type PreviewTableLayoutController = {
  refresh(): void;
  dispose(): void;
};

function tableColumnCount(table: HTMLTableElement): number {
  return Array.from(table.rows).reduce((maximum, row) => (
    Math.max(maximum, Array.from(row.cells).reduce((count, cell) => count + Math.max(1, cell.colSpan), 0))
  ), 0);
}

function ensureColumnGroup(table: HTMLTableElement, columnCount: number): HTMLTableColElement[] {
  let group = table.querySelector<HTMLTableColElement>(':scope > colgroup[data-meo-preview-columns]');
  if (!group) {
    group = table.ownerDocument.createElement('colgroup');
    group.dataset.meoPreviewColumns = 'true';
    table.prepend(group);
  }
  while (group.children.length > columnCount) group.lastElementChild?.remove();
  while (group.children.length < columnCount) group.append(table.ownerDocument.createElement('col'));
  return Array.from(group.querySelectorAll<HTMLTableColElement>(':scope > col'));
}

function preferredWidthSignature(table: HTMLTableElement, columnCount: number): string {
  const style = table.ownerDocument.defaultView?.getComputedStyle(table) ?? getComputedStyle(table);
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td'))
    .map((cell) => `${cell.colSpan}:${cell.rowSpan}:${cell.textContent ?? ''}`)
    .join('\u0001');
  return [
    columnCount,
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.letterSpacing,
    cells
  ].join('\u0002');
}

function readPreferredWidths(table: HTMLTableElement, columnCount: number, signature: string): number[] {
  const preferred = Array.from({ length: columnCount }, () => DEFAULT_MINIMUM_COLUMN_WIDTH);
  for (const row of Array.from(table.rows)) {
    let columnIndex = 0;
    for (const cell of Array.from(row.cells)) {
      const span = Math.max(1, cell.colSpan);
      const share = cell.getBoundingClientRect().width / span;
      for (let offset = 0; offset < span && columnIndex + offset < columnCount; offset += 1) {
        preferred[columnIndex + offset] = Math.max(preferred[columnIndex + offset], share);
      }
      columnIndex += span;
    }
  }
  preferredWidthCache.set(table, { signature, widths: preferred });
  return preferred;
}

function isTableOnlyHtmlHost(wrapper: HTMLElement): boolean {
  if (!wrapper.classList.contains('meo-export-html-block')) return false;
  return Array.from(wrapper.childNodes).every((node) => (
    (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '')
    || (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'TABLE')
  ));
}

function applyTableWidthPlan(
  table: HTMLTableElement,
  columns: readonly HTMLTableColElement[],
  preferred: readonly number[],
  availableWidth: number,
  authoredPadding: number
): void {
  const plan = planPreviewTableWidths(preferred, availableWidth);
  table.style.width = `${plan.totalWidth}px`;
  plan.widths.forEach((width, index) => { columns[index].style.width = `${width}px`; });
  const compressed = availableWidth < DEFAULT_MINIMUM_COLUMN_WIDTH * columns.length;
  // Clear the previous compact pass so it cannot feed its own
  // custom padding back into the next ResizeObserver refresh.
  table.classList.remove('meo-preview-table-compressed');
  table.style.removeProperty('--meo-preview-table-cell-inline-padding');
  if (compressed) {
    const smallestColumn = Math.min(...plan.widths);
    // Keep at least a few CSS pixels for a breakable glyph after borders and
    // padding. Without this, a legal narrow column can still have scrollWidth
    // larger than clientWidth and the wrapper merely clips its last pixels.
    const compactPadding = Math.min(
      authoredPadding,
      Math.max(1, Math.min(6, (smallestColumn - 18) / 2))
    );
    table.style.setProperty('--meo-preview-table-cell-inline-padding', `${compactPadding}px`);
    table.classList.add('meo-preview-table-compressed');
  }
}

function visibleRightEdgeInset(table: HTMLTableElement): number {
  const view = table.ownerDocument.defaultView;
  const devicePixelRatio = Math.max(1, view?.devicePixelRatio ?? 1);
  let outerBorderWidth = 0;
  for (const row of Array.from(table.rows)) {
    const lastCell = row.cells.item(row.cells.length - 1);
    if (!lastCell) continue;
    const style = view?.getComputedStyle(lastCell) ?? getComputedStyle(lastCell);
    const width = Number.parseFloat(style.borderRightWidth);
    if (Number.isFinite(width)) outerBorderWidth = Math.max(outerBorderWidth, width);
  }
  // overflow: clip must not coincide with a collapsed/antialiased border edge.
  // Reserve at least one physical pixel and the full declared outer border so
  // both the last border and the last cell's paint remain visibly inside.
  return Math.max(1 / devicePixelRatio, outerBorderWidth);
}

function layoutTables(tables: readonly HTMLTableElement[]): void {
  const entries = tables.flatMap(table => {
    const wrapper = table.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block') ?? table.parentElement;
    const columnCount = tableColumnCount(table);
    if (!wrapper || columnCount === 0) return [];
    const columns = ensureColumnGroup(table, columnCount);
    table.classList.remove('meo-preview-table-compressed');
    table.style.removeProperty('--meo-preview-table-cell-inline-padding');
    return [{ table, wrapper, columns, columnCount }];
  }).map(entry => {
    const signature = preferredWidthSignature(entry.table, entry.columnCount);
    const cached = preferredWidthCache.get(entry.table);
    return { ...entry, signature, preferred: cached?.signature === signature && cached.widths.length === entry.columnCount
      ? [...cached.widths] : null as number[] | null };
  });
  // Prepare every intrinsic measurement before reading any table geometry.
  for (const entry of entries) if (!entry.preferred) {
    for (const column of entry.columns) column.style.width = '';
    entry.table.style.width = 'max-content';
    entry.table.style.minWidth = '0';
    entry.table.style.maxWidth = 'none';
    entry.table.style.tableLayout = 'auto';
  }
  for (const entry of entries) if (!entry.preferred) {
    entry.preferred = readPreferredWidths(entry.table, entry.columnCount, entry.signature);
  }
  for (const { table } of entries) {
    table.style.minWidth = '0';
    table.style.maxWidth = '100%';
    table.style.tableLayout = 'fixed';
  }
  let pending = entries.map(entry => {
    const rightEdgeInset = visibleRightEdgeInset(entry.table);
    const firstCell = entry.table.querySelector<HTMLTableCellElement>('th, td');
    const style = firstCell ? entry.table.ownerDocument.defaultView?.getComputedStyle(firstCell) ?? getComputedStyle(firstCell) : null;
    const authoredPadding = style ? Math.max(1, Math.min(Number.parseFloat(style.paddingInlineStart) || 0, Number.parseFloat(style.paddingInlineEnd) || 0)) : 1;
    return { ...entry, rightEdgeInset, authoredPadding, availableWidth: Math.max(0, entry.wrapper.clientWidth - rightEdgeInset) };
  });
  // Keep fitting synchronous, but batch each correction pass across the document.
  // This preserves the existing three-pass border convergence without a forced
  // layout between every pair of adjacent tables.
  for (let pass = 0; pass < 3 && pending.length > 0; pass += 1) {
    for (const entry of pending) {
      applyTableWidthPlan(entry.table, entry.columns, entry.preferred!, entry.availableWidth, entry.authoredPadding);
    }
    pending = pending.filter(entry => {
      const clippedRightEdge = entry.wrapper.getBoundingClientRect().left + entry.wrapper.clientLeft + entry.wrapper.clientWidth - entry.rightEdgeInset;
      const overhang = entry.table.getBoundingClientRect().right - clippedRightEdge;
      if (overhang <= 0.01) return false;
      entry.availableWidth = Math.max(0, entry.availableWidth - overhang);
      return true;
    });
  }
  for (const { wrapper } of entries) {
    wrapper.classList.toggle('meo-preview-table-only-html', isTableOnlyHtmlHost(wrapper));
    wrapper.classList.remove('is-table-overflowing');
  }
}
export function createPreviewTableLayoutController(frameDocument: Document): PreviewTableLayoutController {
  let disposed = false;
  let frame: number | null = null;
  const observedWidths = new WeakMap<Element, number>();
  const tables = () => Array.from(frameDocument.querySelectorAll<HTMLTableElement>(
    '.meo-table-scroll > table, .meo-export-html-block table'
  ));
  const refresh = () => {
    if (disposed) return;
    const currentTables = tables();
    // Nested tables depend on their parent geometry; retain document order there.
    if (currentTables.some(table => table.parentElement?.closest('table'))) {
      for (const table of currentTables) layoutTables([table]);
    } else layoutTables(currentTables);
  };
  const scheduleRefresh = () => {
    if (disposed || frame !== null) return;
    frame = frameDocument.defaultView?.requestAnimationFrame(() => {
      frame = null;
      refresh();
    }) ?? null;
  };
  const FrameResizeObserver = frameDocument.defaultView
    ? (frameDocument.defaultView as unknown as Pick<typeof globalThis, 'ResizeObserver'>).ResizeObserver
    : null;
  const observer = FrameResizeObserver ? new FrameResizeObserver((entries) => {
    const widthChanged = entries.some((entry) => {
      const previous = observedWidths.get(entry.target);
      const width = entry.contentRect.width;
      observedWidths.set(entry.target, width);
      return previous === undefined || Math.abs(previous - width) > 0.5;
    });
    if (widthChanged) scheduleRefresh();
  }) : null;
  for (const table of tables()) {
    const wrapper = table.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block') ?? table.parentElement;
    if (wrapper) {
      observedWidths.set(wrapper, wrapper.clientWidth);
      observer?.observe(wrapper);
    }
  }
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      observer?.disconnect();
      if (frame !== null) frameDocument.defaultView?.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
