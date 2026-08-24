import { Facet } from '@codemirror/state';

export type TableWidgetLayoutRegistration = {
  request(): void;
  dispose(): void;
};

export type TableWidgetLayoutScheduler = {
  register(task: () => void): TableWidgetLayoutRegistration;
};

export type TableStickyHeaderElements = {
  readonly scroller: HTMLElement;
  readonly horizontalScroller: HTMLElement;
  readonly table: HTMLTableElement;
  readonly stickyChrome: HTMLElement;
  readonly stickyHeaderViewport: HTMLElement;
  readonly stickyTable: HTMLTableElement;
  readonly stickyHeaderRow: HTMLTableRowElement;
};

export type TableStickyHeaderAdapterOptions = {
  readonly scheduler: TableWidgetLayoutScheduler;
  readonly resolveElements: () => TableStickyHeaderElements | null;
  readonly controlsHeight: () => number;
  readonly renderHeaderCell: (column: number) => HTMLTableCellElement;
};

/** Editor-internal lifecycle seam. DOM and scheduling details stay in the concrete adapter. */
export type TableStickyHeaderAdapter = {
  mount(): void;
  update(): void;
  invalidate(): void;
  unmount(): void;
  dispose(): void;
};

export type TableStickyHeaderAdapterFactory = {
  create(options: TableStickyHeaderAdapterOptions): TableStickyHeaderAdapter;
};

export const tableStickyHeaderAdapterFactoryFacet = Facet.define<
  TableStickyHeaderAdapterFactory,
  TableStickyHeaderAdapterFactory | null
>({
  combine(values) {
    if (values.length > 1) {
      throw new Error('Only one Table Sticky Header Adapter factory may be installed');
    }
    return values[0] ?? null;
  }
});
