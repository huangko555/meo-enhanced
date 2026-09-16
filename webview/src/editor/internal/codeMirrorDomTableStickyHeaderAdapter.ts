import type {
  TableStickyHeaderAdapterOptions,
  TableStickyHeaderElements,
  TableStickyHeaderAdapter
} from '../tableStickyHeaderAdapter';
import type { TableStickyHeaderPolicy } from '../tableStickyHeaderPolicy';
import {
  projectFixedChromeGeometry
} from '../fixedChromeGeometry';
import { measureFixedContainingBlockMapping } from '../fixedChromeDomGeometry';

export type CodeMirrorDomTableStickyHeaderAdapterOptions = TableStickyHeaderAdapterOptions & {
  readonly policy: TableStickyHeaderPolicy;
};

type LifecyclePhase = 'unmounted' | 'mounted' | 'disposed';

type StickyGeneration = {
  readonly id: number;
  readonly elements: TableStickyHeaderElements;
  readonly cleanup: Array<() => void>;
};

const noPrimaryError = Symbol('no-primary-error');

function makeStickyContentPassive(root: HTMLElement): void {
  if (root.getAttribute('aria-hidden') !== 'true') root.setAttribute('aria-hidden', 'true');
  if (root.getAttribute('contenteditable') !== 'false') root.setAttribute('contenteditable', 'false');
  for (const interactive of Array.from(root.querySelectorAll('button, textarea, input, select'))) {
    interactive.remove();
  }
  for (const editable of Array.from(root.querySelectorAll<HTMLElement>('[contenteditable]'))) {
    if (editable.getAttribute('contenteditable') !== 'false') editable.setAttribute('contenteditable', 'false');
  }
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    link.replaceWith(...Array.from(link.childNodes));
  }
  for (const focusable of Array.from(root.querySelectorAll('[tabindex]'))) {
    focusable.removeAttribute('tabindex');
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
): boolean {
  if (!layout.visible) {
    hide(elements);
    return false;
  }
  const mapping = measureFixedContainingBlockMapping(elements.stickyChrome);
  if (!mapping) {
    hide(elements);
    return false;
  }
  const projection = projectFixedChromeGeometry(mapping, {
    rect: {
      left: layout.left,
      top: layout.top,
      width: layout.width,
      height: layout.height
    },
    vectors: [
      { x: layout.tableWidth, y: 0 },
      { x: layout.translateX, y: 0 },
      { x: 0, y: layout.headerHeight }
    ]
  });
  if (!projection.ok) {
    hide(elements);
    return false;
  }
  const [tableWidth, translate, headerHeight] = projection.geometry.vectors;
  elements.stickyChrome.classList.add('is-visible');
  elements.stickyChrome.classList.toggle('has-sticky-controls', layout.controlsHeight > 0);
  elements.stickyChrome.style.top = `${projection.geometry.rect.top}px`;
  elements.stickyChrome.style.left = `${projection.geometry.rect.left}px`;
  elements.stickyChrome.style.width = `${projection.geometry.rect.width}px`;
  elements.stickyChrome.style.height = `${projection.geometry.rect.height}px`;
  elements.stickyHeaderViewport.style.height = `${headerHeight.y}px`;
  elements.stickyTable.style.width = `${tableWidth.x}px`;
  elements.stickyTable.style.transform = `translateX(${translate.x}px)`;
  return true;
}

function throwLifecycleErrors(
  primary: unknown | typeof noPrimaryError,
  cleanupErrors: readonly unknown[]
): void {
  if (primary !== noPrimaryError) {
    if (cleanupErrors.length === 0) throw primary;
    throw new AggregateError([primary, ...cleanupErrors],
      'Table Sticky Header action and cleanup failed', { cause: primary });
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Table Sticky Header cleanup failed', {
      cause: cleanupErrors[0]
    });
  }
}

function runCleanupInReverse(cleanup: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (let index = cleanup.length - 1; index >= 0; index -= 1) {
    try {
      cleanup[index]();
    } catch (error) {
      errors.push(error);
    }
  }
  cleanup.length = 0;
  return errors;
}

function clonePassiveHeader(source: HTMLTableRowElement): HTMLTableCellElement[] {
  return Array.from(source.cells, (cell) => {
    const clone = cell.cloneNode(true) as HTMLTableCellElement;
    // The floating header is a passive projection, even when its source cell is
    // currently being edited. Keeping the transient editing class would hide
    // the cloned preview, while passive cleanup removes the cloned textarea.
    for (const content of Array.from(clone.querySelectorAll<HTMLElement>(
      '.meo-md-html-table-cell-content.is-editing'
    ))) {
      content.classList.remove('is-editing');
    }
    makeStickyContentPassive(clone);
    return clone;
  });
}

function replaceProjectedHeaderCells(
  row: HTMLTableRowElement,
  cells: HTMLTableCellElement[],
  interactive: { readonly column: number; readonly cell: HTMLTableCellElement } | null
): void {
  if (!interactive) {
    row.replaceChildren(...cells);
    return;
  }
  for (let column = 0; column < cells.length; column += 1) {
    const next = cells[column];
    const current = row.cells.item(column);
    if (current === next) continue;
    if (current) current.replaceWith(next);
    else row.appendChild(next);
  }
  while (row.cells.length > cells.length) row.lastElementChild?.remove();
}

function areSameElements(
  left: TableStickyHeaderElements,
  right: TableStickyHeaderElements
): boolean {
  return left.scroller === right.scroller &&
    left.horizontalScroller === right.horizontalScroller &&
    left.table === right.table &&
    left.stickyChrome === right.stickyChrome &&
    left.stickyHeaderViewport === right.stickyHeaderViewport &&
    left.stickyTable === right.stickyTable &&
    left.stickyHeaderRow === right.stickyHeaderRow;
}

export function createCodeMirrorDomTableStickyHeaderAdapter(
  options: CodeMirrorDomTableStickyHeaderAdapterOptions
): TableStickyHeaderAdapter {
  let phase: LifecyclePhase = 'unmounted';
  let nextGeneration = 0;
  let current: StickyGeneration | null = null;
  let dirty = false;
  let refreshing = false;
  let visible = false;

  const notifyVisibility = (nextVisible: boolean): void => {
    if (visible === nextVisible) return;
    visible = nextVisible;
    options.visibilityChanged?.(visible);
  };

  const registration = options.scheduler.register(() => {
    if (phase !== 'mounted' || !current || refreshing) return;
    dirty = false;
    refreshing = true;
    try {
      const elements = current.elements;
      const header = elements.table.tHead?.rows[0];
      const bodyRows = elements.table.tBodies[0]?.rows.length ?? 0;
      if (!header || bodyRows === 0) {
        hide(elements);
        notifyVisibility(false);
        return;
      }
      const scrollerRect = elements.scroller.getBoundingClientRect();
      const tableRect = elements.table.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      notifyVisibility(applyLayout(elements, options.policy.layout({
        scroller: {
          top: scrollerRect.top, left: scrollerRect.left,
          right: scrollerRect.right, height: scrollerRect.height
        },
        table: {
          left: tableRect.left, right: tableRect.right, bottom: tableRect.bottom,
          height: tableRect.height, width: tableRect.width
        },
        header: { top: headerRect.top, height: headerRect.height },
        controlsHeight: options.controlsHeight()
      })));
    } finally {
      refreshing = false;
      if (dirty && phase === 'mounted') registration.request();
    }
  });

  const invalidate = (): void => {
    if (phase !== 'mounted') return;
    dirty = true;
    registration.request();
  };

  const releaseCurrent = (hideReleased = true): unknown[] => {
    const previous = current;
    current = null;
    dirty = false;
    nextGeneration += 1;
    if (!previous) return [];
    const errors = runCleanupInReverse(previous.cleanup);
    if (hideReleased) {
      try {
        delete previous.elements.stickyChrome.dataset.tableStickyHeaderOwner;
        hide(previous.elements);
        notifyVisibility(false);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  const installGeneration = (elements: TableStickyHeaderElements): void => {
    const previousElements = current?.elements;
    const cleanupErrors = releaseCurrent(
      previousElements ? !areSameElements(previousElements, elements) : false
    );
    const id = ++nextGeneration;
    const cleanup: Array<() => void> = [];
    let primary: unknown | typeof noPrimaryError = noPrimaryError;
    try {
      const sourceHeader = elements.table.tHead?.rows[0];
      const nextCells = sourceHeader ? clonePassiveHeader(sourceHeader) : [];
      const interactive = options.resolveInteractiveCell?.() ?? null;
      if (interactive && interactive.column >= 0 && interactive.column < nextCells.length) {
        interactive.cell.classList.add('meo-md-html-table-sticky-interactive-cell');
        interactive.cell.removeAttribute('aria-hidden');
        nextCells[interactive.column] = interactive.cell;
      }
      const active = (): boolean => phase === 'mounted' && current?.id === id;
      const requestIfActive = (): void => {
        if (active()) invalidate();
      };
      const replaceIfActive = (): void => {
        if (active()) installGeneration(elements);
      };

      window.addEventListener('resize', requestIfActive);
      cleanup.push(() => window.removeEventListener('resize', requestIfActive));
      const ownerDocument = elements.scroller.ownerDocument;
      const onVerticalScroll = (event: Event): void => {
        const target = event.target;
        if (target instanceof Node && target.contains(elements.scroller)) requestIfActive();
      };
      ownerDocument.addEventListener('scroll', onVerticalScroll, true);
      cleanup.push(() => ownerDocument.removeEventListener('scroll', onVerticalScroll, true));
      elements.horizontalScroller.addEventListener('scroll', requestIfActive);
      cleanup.push(() => elements.horizontalScroller.removeEventListener('scroll', requestIfActive));
      const resizeObserver = new ResizeObserver(requestIfActive);
      resizeObserver.observe(elements.scroller);
      cleanup.push(() => resizeObserver.disconnect());
      const mutationObserver = new MutationObserver(replaceIfActive);
      mutationObserver.observe(elements.table, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true
      });
      cleanup.push(() => mutationObserver.disconnect());
      const shell = elements.stickyChrome.parentElement;
      const normalizeShellClass = (value: string | null): string => (value ?? '')
        .split(/\s+/)
        .filter((name) => name && name !== 'is-controls-sticky')
        .sort()
        .join(' ');
      const normalizeShellStyle = (value: string | null): string => (value ?? '')
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration &&
          !declaration.startsWith('--meo-html-table-sticky-top:') &&
          !declaration.startsWith('--meo-html-table-sticky-left:'))
        .sort()
        .join(';');
      const ancestorObserver = new MutationObserver((records) => {
        const externallyChanged = records.some((record) => {
          if (record.target !== shell) return true;
          if (record.attributeName === 'class') {
            return normalizeShellClass(record.oldValue) !== normalizeShellClass(shell.getAttribute('class'));
          }
          if (record.attributeName === 'style') {
            return normalizeShellStyle(record.oldValue) !== normalizeShellStyle(shell.getAttribute('style'));
          }
          return true;
        });
        if (externallyChanged) requestIfActive();
      });
      let ancestor: HTMLElement | null = shell;
      while (ancestor) {
        ancestorObserver.observe(ancestor, {
          attributes: true,
          attributeFilter: ['class', 'style'],
          attributeOldValue: true
        });
        ancestor = ancestor.parentElement;
      }
      cleanup.push(() => ancestorObserver.disconnect());
      const handleStickyInteraction = (event: Event): void => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('.meo-md-html-table-column-resize-handle')) return;
        if (event.target.closest('.meo-md-html-table-sticky-interactive-cell')) return;
        const cell = event.target.closest('th');
        if (!(cell instanceof HTMLTableCellElement) || !elements.stickyHeaderRow.contains(cell)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type !== 'pointerdown' || !(event instanceof PointerEvent) || event.button !== 0) return;
        const column = cell.cellIndex;
        if (column < 0) return;
        options.activateCell?.({
          column,
          projectedCell: cell,
          clientX: event.clientX,
          clientY: event.clientY
        });
      };
      const passiveEvents = ['pointerdown', 'click', 'dblclick'] as const;
      for (const eventName of passiveEvents) {
        elements.stickyHeaderViewport.addEventListener(eventName, handleStickyInteraction, true);
        cleanup.push(() => {
          elements.stickyHeaderViewport.removeEventListener(eventName, handleStickyInteraction, true);
        });
      }

      if (interactive) {
        elements.stickyHeaderViewport.removeAttribute('aria-hidden');
        elements.stickyHeaderViewport.removeAttribute('contenteditable');
      } else {
        makeStickyContentPassive(elements.stickyHeaderViewport);
      }
      replaceProjectedHeaderCells(elements.stickyHeaderRow, nextCells, interactive);
      elements.stickyChrome.dataset.tableStickyHeaderOwner = 'adapter';
      current = { id, elements, cleanup };
      phase = 'mounted';
      invalidate();
    } catch (error) {
      primary = error;
      nextGeneration += 1;
      cleanupErrors.push(...runCleanupInReverse(cleanup));
      current = null;
      phase = 'unmounted';
      try {
        delete elements.stickyChrome.dataset.tableStickyHeaderOwner;
        hide(elements);
        notifyVisibility(false);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    throwLifecycleErrors(primary, cleanupErrors);
  };

  const unmount = (): void => {
    if (phase !== 'mounted') return;
    phase = 'unmounted';
    throwLifecycleErrors(noPrimaryError, releaseCurrent());
  };

  const mount = (): void => {
    if (phase === 'disposed') return;
    let elements: TableStickyHeaderElements | null = null;
    let primary: unknown | typeof noPrimaryError = noPrimaryError;
    try {
      elements = options.resolveElements();
    } catch (error) {
      primary = error;
    }
    if (primary !== noPrimaryError || !elements) {
      phase = 'unmounted';
      const cleanupErrors = releaseCurrent();
      throwLifecycleErrors(primary, cleanupErrors);
      return;
    }
    installGeneration(elements);
  };

  const update = (): void => {
    if (phase === 'disposed') return;
    let elements: TableStickyHeaderElements | null = null;
    let primary: unknown | typeof noPrimaryError = noPrimaryError;
    try {
      elements = options.resolveElements();
    } catch (error) {
      primary = error;
    }
    if (primary !== noPrimaryError) throwLifecycleErrors(primary, []);
    if (!elements) {
      unmount();
      return;
    }
    installGeneration(elements);
  };

  return {
    mount,
    update,
    invalidate,
    unmount,
    dispose() {
      if (phase === 'disposed') return;
      phase = 'disposed';
      const cleanupErrors = releaseCurrent();
      try {
        registration.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
      throwLifecycleErrors(noPrimaryError, cleanupErrors);
    }
  };
}
