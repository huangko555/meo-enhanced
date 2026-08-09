import type {
  TableWidgetLayoutScheduler,
  TableStickyHeaderAdapter
} from '../tableStickyHeaderAdapter';
import type { TableStickyHeaderPolicy } from '../tableStickyHeaderPolicy';

type StickyHeaderElements = {
  readonly shell: HTMLElement;
  readonly scroller: HTMLElement;
  readonly table: HTMLTableElement;
  readonly stickyChrome: HTMLElement;
  readonly stickyHeaderViewport: HTMLElement;
  readonly stickyTable: HTMLTableElement;
  readonly stickyHeaderRow: HTMLTableRowElement;
};

export type CodeMirrorDomTableStickyHeaderAdapterOptions = {
  readonly policy: TableStickyHeaderPolicy;
  readonly scheduler: TableWidgetLayoutScheduler;
  readonly resolveElements: () => StickyHeaderElements | null;
  readonly controlsVisible: () => boolean;
};

const widthProjectionEvent = 'meo-table-column-width-projected';

function makeStickyContentPassive(root: HTMLElement): void {
  root.setAttribute('aria-hidden', 'true');
  root.style.pointerEvents = 'none';
  for (const interactive of Array.from(root.querySelectorAll(
    'button, textarea, input, select, [contenteditable="true"]'
  ))) {
    interactive.remove();
  }
  for (const link of Array.from(root.querySelectorAll('a[href], [tabindex]'))) {
    link.removeAttribute('href');
    link.removeAttribute('tabindex');
  }
}

function hide(elements: StickyHeaderElements): void {
  elements.stickyChrome.classList.remove('is-visible', 'has-sticky-controls');
  for (const property of ['top', 'left', 'width', 'height']) {
    elements.stickyChrome.style.removeProperty(property);
  }
}

function applyLayout(
  elements: StickyHeaderElements,
  layout: ReturnType<TableStickyHeaderPolicy['layout']>
): void {
  if (!layout.visible) {
    hide(elements);
    return;
  }
  elements.stickyChrome.classList.add('is-visible');
  elements.stickyChrome.classList.toggle('has-sticky-controls', layout.controlsHeight > 0);
  elements.stickyChrome.style.top = `${layout.top}px`;
  elements.stickyChrome.style.left = `${layout.left}px`;
  elements.stickyChrome.style.width = `${layout.width}px`;
  elements.stickyChrome.style.height = `${layout.height}px`;
  elements.stickyHeaderViewport.style.height = `${layout.headerHeight}px`;
  elements.stickyTable.style.width = `${layout.tableWidth}px`;
  elements.stickyTable.style.transform = `translateX(${layout.translateX}px)`;
}

export function createCodeMirrorDomTableStickyHeaderAdapter(
  options: CodeMirrorDomTableStickyHeaderAdapterOptions
): TableStickyHeaderAdapter {
  let disposed = false;
  let mounted = false;
  let dirty = false;
  let refreshing = false;
  let generation = 0;
  let cleanup: (() => void)[] = [];
  let mountedElements: StickyHeaderElements | null = null;

  const registration = options.scheduler.register(() => {
    if (disposed || !mounted || !dirty || refreshing) return;
    dirty = false;
    refreshing = true;
    try {
      const elements = mountedElements;
      const header = elements?.table.tHead?.rows[0];
      const bodyRows = elements?.table.tBodies[0]?.rows.length ?? 0;
      if (!elements || !header || bodyRows === 0) {
        if (elements) hide(elements);
        return;
      }
      const scrollerRect = elements.scroller.getBoundingClientRect();
      const tableRect = elements.table.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      applyLayout(elements, options.policy.layout({
        scroller: {
          top: scrollerRect.top,
          left: scrollerRect.left,
          right: scrollerRect.right,
          height: scrollerRect.height
        },
        table: {
          top: tableRect.top,
          left: tableRect.left,
          right: tableRect.right,
          bottom: tableRect.bottom,
          height: tableRect.height,
          width: tableRect.width
        },
        header: { top: headerRect.top, height: headerRect.height },
        controlsVisible: options.controlsVisible()
      }));
    } finally {
      refreshing = false;
      if (dirty && mounted && !disposed) registration.request();
    }
  });

  const invalidate = (): void => {
    if (disposed || !mounted) return;
    dirty = true;
    registration.request();
  };

  const refreshContent = (): void => {
    if (disposed || !mounted) return;
    const elements = mountedElements;
    const sourceCells = Array.from(elements?.table.tHead?.rows[0]?.cells ?? []);
    if (!elements) return;
    const nextCells = sourceCells.map((sourceCell) => {
      const cell = sourceCell.cloneNode(true) as HTMLTableCellElement;
      makeStickyContentPassive(cell);
      return cell;
    });
    elements.stickyHeaderRow.replaceChildren(...nextCells);
    makeStickyContentPassive(elements.stickyHeaderViewport);
    invalidate();
  };

  const unmount = (): void => {
    if (!mounted) return;
    mounted = false;
    dirty = false;
    generation += 1;
    for (const dispose of cleanup.splice(0)) dispose();
    const elements = mountedElements;
    mountedElements = null;
    if (elements) hide(elements);
  };

  const mount = (): void => {
    if (disposed) return;
    unmount();
    const elements = options.resolveElements();
    if (!elements) return;
    mountedElements = elements;
    mounted = true;
    const mountedGeneration = ++generation;
    const active = (): boolean => mounted && !disposed && generation === mountedGeneration;
    const requestIfActive = (): void => {
      if (active()) invalidate();
    };
    const refreshIfActive = (): void => {
      if (!active()) return;
      refreshContent();
    };

    elements.scroller.addEventListener('scroll', requestIfActive, { passive: true });
    window.addEventListener('resize', requestIfActive);
    elements.table.addEventListener(widthProjectionEvent, requestIfActive);
    cleanup.push(() => elements.scroller.removeEventListener('scroll', requestIfActive));
    cleanup.push(() => window.removeEventListener('resize', requestIfActive));
    cleanup.push(() => elements.table.removeEventListener(widthProjectionEvent, requestIfActive));

    const resizeObserver = new ResizeObserver(requestIfActive);
    resizeObserver.observe(elements.scroller);
    resizeObserver.observe(elements.table);
    const header = elements.table.tHead?.rows[0];
    if (header) resizeObserver.observe(header);
    cleanup.push(() => resizeObserver.disconnect());

    const mutationObserver = new MutationObserver(refreshIfActive);
    mutationObserver.observe(elements.table, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    cleanup.push(() => mutationObserver.disconnect());

    refreshContent();
  };

  return {
    mount,
    update() {
      if (disposed) return;
      mount();
    },
    invalidate,
    refreshContent,
    unmount,
    dispose() {
      if (disposed) return;
      unmount();
      disposed = true;
      registration.dispose();
    }
  };
}
