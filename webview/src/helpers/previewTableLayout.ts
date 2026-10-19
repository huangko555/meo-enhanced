import { planAutomaticTableWidths, type AutomaticTableWidthPlan } from '../application/automaticTableWidths';

const DEFAULT_MINIMUM_COLUMN_WIDTH = 90;
const preferredWidthCache = new WeakMap<HTMLTableElement, {
  readonly signature: string;
  readonly widths: readonly number[];
}>();

export type PreviewTableWidthPlan = AutomaticTableWidthPlan;
export const planPreviewTableWidths = planAutomaticTableWidths;

export type PreviewTableLayoutController = {
  refresh(): void;
  dispose(): void;
};

function tableColumnCount(table: HTMLTableElement): number {
  let group: Element | null = null;
  let rowIndex = 0;
  let count = 0;
  const occupied: number[] = [];
  for (const row of Array.from(table.rows)) {
    if (row.parentElement !== group) {
      group = row.parentElement;
      occupied.length = 0;
      rowIndex = 0;
    }
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      // Row spans reserve slots within this row group; rowspan=0 lasts to its end.
      while ((occupied[column] ?? 0) > rowIndex) column++;
      const end = column + Math.max(1, cell.colSpan);
      for (; column < end; column++) occupied[column] = cell.rowSpan === 0 ? Infinity : rowIndex + cell.rowSpan;
      count = Math.max(count, end);
    }
    rowIndex++;
  }
  return count;
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
  // Native column boxes already account for rowspan/colspan and rich content.
  // Measuring these tracks avoids assigning a spanning cell's average to every column.
  const columns = table.querySelectorAll<HTMLTableColElement>(':scope > colgroup[data-meo-preview-columns] > col');
  const preferred = Array.from({ length: columnCount }, (_, index) => Math.max(1,
    columns[index]?.getBoundingClientRect().width ?? DEFAULT_MINIMUM_COLUMN_WIDTH));
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
  const visibleTables = tables.map(table => {
    const wrapper = table.parentElement?.closest<HTMLElement>('td, th')
      ?? table.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block, .meo-md-html-content') ?? table.parentElement;
    return { table, wrapper };
  }).filter(({ table, wrapper }) => wrapper && table.getClientRects().length && wrapper.clientWidth > 0);
  const entries = visibleTables.flatMap(({ table, wrapper }) => {
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
/** Mount after attachment and dispose with the reading document or rendered HTML widget. */
export function createPreviewTableLayoutController(
  frameDocument: Document,
  root: Document | HTMLElement = frameDocument
): PreviewTableLayoutController {
  let disposed = false;
  let frame: number | null = null;
  const observedWidths = new WeakMap<Element, number>();
  const tables = () => Array.from(root.querySelectorAll<HTMLTableElement>(
    '.meo-table-scroll > table, .meo-export-html-block table, .meo-md-html-content table'
  ));
  const frameWindow = frameDocument.defaultView;
  const deferOffscreen = root === frameDocument
    && frameDocument.documentElement.dataset.meoPreviewLargeDocument === 'true'
    && !!frameWindow?.IntersectionObserver;
  const nearbyTables = new Set<HTMLTableElement>();
  const refresh = () => {
    if (disposed) return;
    const currentTables = deferOffscreen ? [...nearbyTables].filter(table => table.isConnected) : tables();
    // Nested tables depend on their parent geometry; retain document order there.
    if (currentTables.some(table => table.parentElement?.closest('table'))) {
      currentTables.sort((left, right) => left === right ? 0
        : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
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
  const widthOwner = (table: HTMLTableElement) => table.closest<HTMLElement>(
    '.meo-table-scroll, .meo-export-html-block, .meo-md-html-content') ?? table.parentElement;
  const observeWidth = (table: HTMLTableElement, visible: boolean) => {
    const wrapper = widthOwner(table);
    if (wrapper) {
      if (visible) {
        observedWidths.set(wrapper, wrapper.clientWidth);
        observer?.observe(wrapper);
      } else if (![...nearbyTables].some(nearby => widthOwner(nearby) === wrapper)) observer?.unobserve(wrapper);
    }
  };
  // Intrinsic column measurement forces layout. Limit it to tables approaching
  // the viewport; revisiting a table still reuses its measured font/content key.
  const visibilityObserver = deferOffscreen ? new frameWindow!.IntersectionObserver(entries => {
    if (disposed) return;
    for (const entry of entries) {
      const table = entry.target as HTMLTableElement;
      if (entry.isIntersecting) nearbyTables.add(table);
      else nearbyTables.delete(table);
      observeWidth(table, entry.isIntersecting);
    }
    scheduleRefresh();
  }, { rootMargin: '800px 0px' }) : null;
  const trackedTables = new Set<HTMLTableElement>();
  const synchronizeTables = () => {
    const current = new Set(tables());
    for (const table of trackedTables) if (!current.has(table)) {
      trackedTables.delete(table); nearbyTables.delete(table);
      visibilityObserver?.unobserve(table); observeWidth(table, false);
    }
    for (const table of current) if (!trackedTables.has(table)) {
      trackedTables.add(table);
      if (visibilityObserver) visibilityObserver.observe(table);
      else observeWidth(table, true);
    }
  };
  synchronizeTables();
  root.addEventListener('toggle', scheduleRefresh, true);
  refresh();
  return {
    refresh() { synchronizeTables(); refresh(); },
    dispose() {
      disposed = true;
      observer?.disconnect();
      visibilityObserver?.disconnect();
      nearbyTables.clear();
      trackedTables.clear();
      root.removeEventListener('toggle', scheduleRefresh, true);
      if (frame !== null) frameDocument.defaultView?.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
