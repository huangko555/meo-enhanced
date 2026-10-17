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
  readonly navigateToSourceHeader?: () => void;
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
  // Offscreen widgets may never mount or receive destroy. Register only mounted
  // delegates so rebuilding a document cannot retain every discarded table.
  const entries = new Set<TableStickyHeaderAdapter>();
  let enabled = initiallyEnabled;

  return {
    create(options) {
      let delegate: TableStickyHeaderAdapter | null = null;
      let mounted = false;
      return {
        mount() {
          delegate ??= delegateFactory.create(options);
          mounted = true;
          entries.add(delegate);
          if (enabled) delegate.mount();
        },
        update() {
          if (mounted && enabled) delegate?.update();
        },
        invalidate() {
          if (mounted && enabled) delegate?.invalidate();
        },
        unmount() {
          mounted = false;
          if (delegate) {
            entries.delete(delegate);
            delegate.unmount();
          }
        },
        dispose() {
          mounted = false;
          if (delegate) {
            entries.delete(delegate);
            delegate.dispose();
            delegate = null;
          }
        }
      };
    },
    setEnabled(nextEnabled) {
      if (nextEnabled === enabled) return;
      enabled = nextEnabled;
      for (const delegate of entries) {
        if (enabled) delegate.mount();
        else delegate.unmount();
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
