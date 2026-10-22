type RowBounds = { top: number; bottom: number };
/** Rows keep source identities; DOM and measured heights are a reading projection. */
export type TableRowWindow = {
  update(): void;
  invalidate(): void;
  ensure(index: number): HTMLTableRowElement | undefined;
  bounds(index: number): RowBounds | undefined;
  dispose(): void;
};

const windows = new WeakMap<HTMLTableSectionElement, TableRowWindow>();
export const tableRowWindowFor = (body: HTMLTableSectionElement): TableRowWindow | undefined => windows.get(body);

class RowHeights {
  private values: Float64Array;
  private sums: Float64Array;
  constructor(readonly count: number, estimate: number) {
    this.values = new Float64Array(count).fill(estimate);
    this.sums = new Float64Array(count + 1);
    for (let i = 1; i <= count; i++) this.sums[i] = (i & -i) * estimate;
  }
  offset(index: number): number {
    let sum = 0;
    for (let i = Math.min(index, this.count); i > 0; i -= i & -i) sum += this.sums[i]!;
    return sum;
  }
  measure(index: number, height: number): void {
    if (!(height > 0) || !Number.isFinite(height)) return;
    const delta = height - this.values[index]!;
    if (Math.abs(delta) < .1) return;
    this.values[index] = height;
    for (let i = index + 1; i <= this.count; i += i & -i) this.sums[i] += delta;
  }
  indexAt(position: number): number {
    let low = 0, high = this.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offset(middle + 1) <= position) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, Math.min(this.count - 1, low));
  }
}

export function createTableRowWindow(options: {
  body: HTMLTableSectionElement;
  viewport: HTMLElement;
  rowCount: number;
  columnCount: number;
  estimateHeight: number;
  estimatedHeights?: readonly number[];
  render(index: number): HTMLTableRowElement;
  release(index: number, row: HTMLTableRowElement): void;
  retain(): Iterable<number>;
  scrollbarDragging(): boolean;
  size(rows: readonly HTMLTableRowElement[]): void;
  changed(): void;
}): TableRowWindow {
  const { body, viewport, rowCount, columnCount } = options;
  const rowHeights = new RowHeights(rowCount, options.estimateHeight);
  options.estimatedHeights?.forEach((height, index) => { if (index < rowCount) rowHeights.measure(index, height); });
  const rows = new Map<number, HTMLTableRowElement>();
  let gaps: Array<{ element: HTMLTableRowElement; from: number; to: number }> = [];
  let extra: number | undefined, disposed = false, updating = false, previousKey = '', sized = false;
  let dragHeight: number | undefined, finishFrame: number | undefined;
  const dragMeasurements = new Map<number, number>();
  let observer: ResizeObserver | undefined;
  const valid = (index: number) => Number.isInteger(index) && index >= 0 && index < rowCount;
  const mounted = () => [...rows].sort(([a], [b]) => a - b).map(([index, element]) => ({ index, element }));
  const spacer = (height: number): HTMLTableRowElement => {
    const row = body.ownerDocument.createElement('tr');
    row.className = 'meo-table-row-gap'; row.setAttribute('aria-hidden', 'true');
    const cell = body.ownerDocument.createElement('td'); cell.colSpan = columnCount;
    cell.style.height = `${Math.max(0, height)}px`; row.append(cell); return row;
  };
  const reconcile = (wanted: readonly number[]) => {
    const key = wanted.join(',');
    if (key === previousKey) {
      for (const gap of gaps) {
        const height = `${rowHeights.offset(gap.to) - rowHeights.offset(gap.from)}px`;
        if (gap.element.cells[0]!.style.height !== height) gap.element.cells[0]!.style.height = height;
      }
      return false;
    }
    previousKey = key;
    let changed = false;
    const keep = new Set(wanted);
    for (const [index, row] of rows) if (!keep.has(index)) {
      observer?.unobserve(row); options.release(index, row); row.remove(); rows.delete(index); changed = true;
    }
    for (const index of wanted) if (!rows.has(index)) {
      const row = options.render(index); rows.set(index, row); observer?.observe(row); changed = true;
    }
    // Keep retained rows in place. Moving an already connected row can blur its
    // native textarea, even when it ends in the same visual position.
    for (const gap of gaps) gap.element.remove(); gaps = [];
    let next: ChildNode | null = body.firstChild, previous = 0;
    for (const index of wanted) {
      if (index > previous) {
        const gap = spacer(rowHeights.offset(index) - rowHeights.offset(previous));
        body.insertBefore(gap, next); gaps.push({ element: gap, from: previous, to: index });
      }
      const row = rows.get(index)!;
      if (row !== next) body.insertBefore(row, next);
      next = row.nextSibling; previous = index + 1;
    }
    if (previous < rowCount) {
      const gap = spacer(rowHeights.offset(rowCount) - rowHeights.offset(previous)); body.append(gap);
      gaps.push({ element: gap, from: previous, to: rowCount });
    }
    return changed;
  };
  const update = () => {
    if (disposed || updating || !rowCount) return;
    updating = true;
    try {
      const dragging = options.scrollbarDragging();
      const endingDrag = !dragging && dragHeight !== undefined;
      const atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1;
      const viewportRect = viewport.getBoundingClientRect(), bodyTop = body.getBoundingClientRect().top;
      if (dragging && dragHeight === undefined) dragHeight = body.getBoundingClientRect().height;
      const beforeAnchor = mounted().find(({ element }) => {
        const rect = element.getBoundingClientRect(); return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
      });
      const anchorTop = endingDrag ? beforeAnchor?.element.getBoundingClientRect().top : undefined;
      if (endingDrag) {
        for (const [index, height] of dragMeasurements) rowHeights.measure(index, height);
        dragMeasurements.clear(); dragHeight = undefined;
      }
      const localTop = Math.max(0, viewportRect.top - bodyTop);
      // A thumb jumps across pages; rebuilding several invisible screens on
      // each jump cannot prefetch its destination. Keep a small reading buffer
      // while held, then restore the ordinary wheel/keyboard overscan on release.
      const margin = dragging ? Math.min(240, viewportRect.height / 4) : Math.max(240, viewportRect.height);
      const first = rowHeights.indexAt(localTop - margin), last = rowHeights.indexAt(localTop + viewportRect.height + margin);
      const keep = new Set<number>();
      if (endingDrag) for (const index of rows.keys()) keep.add(index);
      else for (let i = first; i <= last; i++) keep.add(i);
      for (const index of options.retain()) if (valid(index)) keep.add(index);
      if (extra !== undefined) keep.add(extra);
      if (endingDrag && beforeAnchor) keep.add(beforeAnchor.index);
      const wanted = [...keep].sort((a, b) => a - b);
      const anchorIndex = beforeAnchor?.index ?? rowHeights.indexAt(localTop);
      const oldOffset = rowHeights.offset(anchorIndex);
      // Pure window movement does not change retained cells' natural sizing.
      // Clearing every mounted row's minimum forces another whole-table layout
      // on each scroll. Width/font/content invalidation still sizes every row.
      const needsSize = sized ? wanted.filter(index => !rows.has(index)) : wanted;
      const changed = reconcile(wanted);
      if (changed || !sized) {
        if (needsSize.length) options.size(needsSize.map(index => rows.get(index)!));
        sized = body.isConnected;
      }
      for (const index of wanted) {
        const height = rows.get(index)!.getBoundingClientRect().height;
        if (dragging) dragMeasurements.set(index, height);
        else rowHeights.measure(index, height);
      }
      // Measured overscan rows may change the gap above the reading row. Absorb
      // that delta in the same layout checkpoint, without locking later scrolls.
      const delta = rowHeights.offset(anchorIndex) - oldOffset;
      reconcile(wanted);
      if (body.isConnected) {
        if (dragging && dragHeight !== undefined) {
          // Keep the native scrollbar's range fixed while its thumb owns input.
          // New rows still render at their real height; one invisible gap absorbs
          // the difference until the gesture ends. No scrollTop writes compete
          // with Chrome or CodeMirror while the pointer is held.
          const difference = body.getBoundingClientRect().height - dragHeight;
          const gap = [...gaps].reverse().find(gap => gap.element.cells[0]!.getBoundingClientRect().height >= difference);
          if (gap && Math.abs(difference) > .1) {
            const cell = gap.element.cells[0]!;
            cell.style.height = `${Math.max(0, cell.getBoundingClientRect().height - difference)}px`;
          }
        } else if (endingDrag) {
          if (atBottom) viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
          else if (anchorTop !== undefined && beforeAnchor?.element.isConnected) {
            viewport.scrollTop += beforeAnchor.element.getBoundingClientRect().top - anchorTop;
          }
        } else if (Math.abs(delta) > .1 && localTop > 0) viewport.scrollTop += delta;
      }
      if (changed || endingDrag || Math.abs(delta) > .1) options.changed();
    } finally { updating = false; }
  };
  const finishDrag = () => {
    if (dragHeight === undefined || finishFrame !== undefined) return;
    finishFrame = requestAnimationFrame(() => { finishFrame = undefined; update(); });
  };
  body.ownerDocument.addEventListener('pointerup', finishDrag, true);
  body.ownerDocument.addEventListener('pointercancel', finishDrag, true);
  body.ownerDocument.defaultView?.addEventListener('blur', finishDrag);
  if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(() => { if (body.isConnected) update(); });
  const window: TableRowWindow = {
    update,
    invalidate() { sized = false; },
    ensure(index) { if (!valid(index) || disposed) return; extra = index; update(); extra = undefined; return rows.get(index); },
    bounds(index) { return valid(index) ? { top: rowHeights.offset(index), bottom: rowHeights.offset(index + 1) } : undefined; },
    dispose() {
      disposed = true; observer?.disconnect(); windows.delete(body);
      body.ownerDocument.removeEventListener('pointerup', finishDrag, true);
      body.ownerDocument.removeEventListener('pointercancel', finishDrag, true);
      body.ownerDocument.defaultView?.removeEventListener('blur', finishDrag);
      if (finishFrame !== undefined) cancelAnimationFrame(finishFrame);
      for (const [index, row] of rows) options.release(index, row);
      rows.clear(); gaps = []; dragMeasurements.clear();
    }
  };
  windows.set(body, window);
  return window;
}
