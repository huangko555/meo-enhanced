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
  setEnabled(enabled: boolean): void;
};

export function createToggleableTableStickyHeaderAdapterFactory(
  delegateFactory: Pick<TableStickyHeaderAdapterFactory, 'create'>,
  initiallyEnabled = true
): TableStickyHeaderAdapterFactory {
  const entries = new Set<{
    readonly delegate: TableStickyHeaderAdapter;
    mounted: boolean;
  }>();
  let enabled = initiallyEnabled;

  return {
    create(options) {
      const delegate = delegateFactory.create(options);
      const entry = { delegate, mounted: false };
      entries.add(entry);
      return {
        mount() {
          entry.mounted = true;
          if (enabled) delegate.mount();
        },
        update() {
          if (entry.mounted && enabled) delegate.update();
        },
        invalidate() {
          if (entry.mounted && enabled) delegate.invalidate();
        },
        unmount() {
          entry.mounted = false;
          delegate.unmount();
        },
        dispose() {
          entry.mounted = false;
          entries.delete(entry);
          delegate.dispose();
        }
      };
    },
    setEnabled(nextEnabled) {
      if (nextEnabled === enabled) return;
      enabled = nextEnabled;
      for (const entry of entries) {
        if (!entry.mounted) continue;
        if (enabled) entry.delegate.mount();
        else entry.delegate.unmount();
      }
    }
  };
}

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
