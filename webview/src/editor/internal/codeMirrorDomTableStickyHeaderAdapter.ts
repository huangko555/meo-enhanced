import type {
  TableStickyHeaderAdapterOptions,
  TableStickyHeaderElements,
  TableStickyHeaderAdapter
} from '../tableStickyHeaderAdapter';
import type { TableStickyHeaderPolicy } from '../tableStickyHeaderPolicy';

export type CodeMirrorDomTableStickyHeaderAdapterOptions = TableStickyHeaderAdapterOptions & {
  readonly policy: TableStickyHeaderPolicy;
};

function makeStickyContentPassive(root: HTMLElement): void {
  root.setAttribute('aria-hidden', 'true');
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

function hide(elements: TableStickyHeaderElements): void {
  elements.stickyChrome.classList.remove('is-visible', 'has-sticky-controls');
  for (const property of ['top', 'left', 'width', 'height']) {
    elements.stickyChrome.style.removeProperty(property);
  }
}

function applyLayout(
  elements: TableStickyHeaderElements,
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
  let mountedElements: TableStickyHeaderElements | null = null;

  const registration = options.scheduler.register(() => {
    if (disposed || !mounted || refreshing) return;
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
    const nextCells = sourceCells.map((_sourceCell, column) => {
      const cell = options.renderHeaderCell(column);
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
    if (elements) {
      delete elements.stickyChrome.dataset.tableStickyHeaderOwner;
      hide(elements);
    }
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

    window.addEventListener('resize', requestIfActive);
    cleanup.push(() => window.removeEventListener('resize', requestIfActive));

    const resizeObserver = new ResizeObserver(requestIfActive);
    resizeObserver.observe(elements.scroller);
    cleanup.push(() => resizeObserver.disconnect());

    const mutationObserver = new MutationObserver(refreshIfActive);
    mutationObserver.observe(elements.table, {
      childList: true,
      characterData: true,
      subtree: true
    });
    cleanup.push(() => mutationObserver.disconnect());

    elements.stickyChrome.dataset.tableStickyHeaderOwner = 'adapter';
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
