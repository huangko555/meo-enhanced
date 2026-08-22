import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import {
  tableColumnWidthPolicy,
  type TableColumnWidthPolicy
} from './tableColumnWidthPolicy';
import {
  isLiveInputDerivedWorkRefresh,
  requestLiveInputDerivedWork
} from './liveInputDerivedWork';

export type TableColumnWidthAdapter = {
  acquire(): void;
  release(): void;
  dispose(): void;
};

export type CodeMirrorDomTableColumnWidthAdapter = {
  readonly adapter: TableColumnWidthAdapter;
  readonly extension: Extension;
};

export type CodeMirrorDomTableColumnWidthAdapterOptions = {
  readonly root: HTMLElement;
  readonly policy?: TableColumnWidthPolicy;
};

type WidthIntent = {
  from: number;
  to: number;
  widths: readonly number[];
  initialTotalWidth: number;
  elastic: boolean;
  defaultWidthWasCapped: boolean;
};

type TableBinding = {
  readonly table: HTMLTableElement;
  readonly cleanup: () => void;
  project(): void;
};

type LifecycleEpoch = {
  alive: boolean;
};

const tableSelector = 'table[data-table-column-width]';
const handleSelector = '[data-table-resize-column]';
const projectionEventName = 'meo-table-column-width-projected';
const resizingClassName = 'meo-table-column-resizing';

function sum(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

function numberFromDataset(element: HTMLElement, key: 'tableFrom' | 'tableTo'): number | null {
  const value = Number(element.dataset[key]);
  return Number.isFinite(value) ? value : null;
}

function tableCollapsedOuterBorderWidth(table: HTMLTableElement): number {
  if (getComputedStyle(table).borderCollapse !== 'collapse') return 0;
  const cells = Array.from(table.tHead?.rows[0]?.cells ?? []);
  if (!cells.length) return 0;
  const leftBorder = Number.parseFloat(getComputedStyle(cells[0]).borderLeftWidth) || 0;
  const rightBorder = Number.parseFloat(getComputedStyle(cells[cells.length - 1]).borderRightWidth) || 0;
  return (leftBorder + rightBorder) / 2;
}

export function createCodeMirrorDomTableColumnWidthAdapter(
  options: CodeMirrorDomTableColumnWidthAdapterOptions
): CodeMirrorDomTableColumnWidthAdapter {
  const policy = options.policy ?? tableColumnWidthPolicy;
  const intents: WidthIntent[] = [];
  const bindings = new Map<HTMLTableElement, TableBinding>();
  let mutationObserver: MutationObserver | null = null;
  let currentEpoch: LifecycleEpoch | null = null;
  let currentView: EditorView | null = null;
  let disposed = false;
  const reconcileConsumer = {};

  const isCurrentEpoch = (epoch: LifecycleEpoch): boolean => (
    !disposed && epoch.alive && currentEpoch === epoch
  );

  const findIntent = (table: HTMLTableElement): WidthIntent | null => {
    const from = numberFromDataset(table, 'tableFrom');
    const to = numberFromDataset(table, 'tableTo');
    if (from === null || to === null) return null;
    const columnCount = table.querySelectorAll('thead th').length;
    return intents.find((intent) => (
      intent.from === from && intent.to === to && intent.widths.length === columnCount
    )) ?? null;
  };

  const availableWidth = (table: HTMLTableElement): number => {
    const container = table.parentElement ?? options.root;
    return Math.max(0, container.clientWidth - tableCollapsedOuterBorderWidth(table));
  };

  const stickyTableFor = (table: HTMLTableElement): HTMLTableElement | null => (
    table.closest('.meo-md-html-table-shell')
      ?.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table') ?? null
  );

  const renderStickyColumns = (table: HTMLTableElement, widths: readonly number[]): void => {
    const stickyTable = stickyTableFor(table);
    if (!stickyTable) return;
    const columns = Array.from(stickyTable.querySelectorAll<HTMLTableColElement>('colgroup > col'));
    widths.forEach((width, index) => {
      if (columns[index]) columns[index].style.width = `${width}px`;
    });
  };

  const render = (table: HTMLTableElement, widths: readonly number[], totalWidth: number): void => {
    table.style.width = `${totalWidth}px`;
    table.style.maxWidth = 'none';
    table.style.minWidth = '0';
    table.style.tableLayout = 'fixed';
    const columns = Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup > col'));
    widths.forEach((width, index) => {
      if (columns[index]) columns[index].style.width = `${width}px`;
    });
    renderStickyColumns(table, widths);
  };

  const reset = (table: HTMLTableElement): void => {
    table.style.width = '';
    table.style.maxWidth = '';
    table.style.minWidth = '';
    table.style.tableLayout = '';
    for (const column of table.querySelectorAll<HTMLTableColElement>('colgroup > col')) {
      column.style.width = '';
    }
    renderStickyColumns(
      table,
      Array.from(table.querySelectorAll<HTMLElement>('thead th'))
        .map((cell) => cell.getBoundingClientRect().width)
    );
  };

  const project = (table: HTMLTableElement, epoch: LifecycleEpoch): void => {
    if (!isCurrentEpoch(epoch)) return;
    const intent = findIntent(table);
    if (!intent) {
      reset(table);
      return;
    }
    const result = policy.project({
      widths: intent.widths,
      initialTotalWidth: intent.initialTotalWidth,
      elastic: intent.elastic,
      defaultWidthWasCapped: intent.defaultWidthWasCapped,
      availableWidth: availableWidth(table)
    });
    if (result.reachedAvailableWidth && !intent.elastic) intent.elastic = true;
    render(table, result.widths, result.totalWidth);
  };

  const storeIntent = (table: HTMLTableElement, next: Omit<WidthIntent, 'from' | 'to'>): void => {
    const from = numberFromDataset(table, 'tableFrom');
    const to = numberFromDataset(table, 'tableTo');
    if (from === null || to === null || disposed) return;
    const existing = intents.findIndex((intent) => intent.from === from && intent.to === to);
    const value = { from, to, ...next };
    if (existing >= 0) intents[existing] = value;
    else intents.push(value);
  };

  const bind = (table: HTMLTableElement, epoch: LifecycleEpoch): TableBinding => {
    const cleanups: Array<() => void> = [];
    const lifecycle = { alive: true };
    let dragCleanup: (() => void) | null = null;
    let refreshDragPreview: (() => void) | null = null;
    let resizeFrame = 0;
    const projectionConsumer = {};
    table.dataset.tableColumnWidthOwner = 'adapter';

    const cancelFrame = () => {
      if (!resizeFrame) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
    };
    const isCurrentBinding = () => lifecycle.alive
      && isCurrentEpoch(epoch)
      && table.isConnected
      && options.root.contains(table);
    const requestProjection = (operation: () => void): void => {
      const view = currentView;
      if (view) requestLiveInputDerivedWork(view, projectionConsumer, operation);
      else operation();
    };
    const scheduleProjection = () => {
      requestProjection(() => {
        if (!isCurrentBinding() || resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          requestProjection(() => {
            if (!isCurrentBinding()) return;
            if (refreshDragPreview) refreshDragPreview();
            else project(table, epoch);
            table.dispatchEvent(new CustomEvent(projectionEventName));
          });
        });
      });
    };

    const start = (event: PointerEvent): void => {
      if (!isCurrentBinding() || event.button !== 0) return;
      const handle = event.target instanceof Element
        ? event.target.closest<HTMLElement>(handleSelector)
        : null;
      if (!handle) return;
      const column = Number(handle.dataset.tableResizeColumn);
      const cells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
      if (!Number.isInteger(column) || !cells[column]) return;
      event.preventDefault();
      event.stopPropagation();
      dragCleanup?.();

      const stored = findIntent(table);
      const startWidths = cells.map((cell) => cell.getBoundingClientRect().width);
      const initialTotalWidth = stored?.initialTotalWidth ?? table.getBoundingClientRect().width;
      const startMaximumTotalWidth = availableWidth(table);
      const defaultWidthWasCapped = stored?.defaultWidthWasCapped ?? (
        initialTotalWidth >= startMaximumTotalWidth - 1
      );
      const minimumWidths = cells.map((cell) => {
        const cellStyle = getComputedStyle(cell);
        const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
        const previewStyle = preview ? getComputedStyle(preview) : cellStyle;
        const numeric = (value: string) => Number.parseFloat(value) || 0;
        return numeric(previewStyle.fontSize)
          + numeric(previewStyle.paddingLeft)
          + numeric(previewStyle.paddingRight)
          + numeric(cellStyle.borderLeftWidth)
          + numeric(cellStyle.borderRightWidth);
      });
      const startX = event.clientX;
      let nextWidths: readonly number[] = startWidths;
      let latestClientX = startX;
      const pointerBoundary = table.closest<HTMLElement>('.cm-editor') ?? options.root;

      const renderDragPreview = (): void => {
        if (!isCurrentBinding()) return;
        const maximumTotalWidth = availableWidth(table);
        const result = policy.resize({
          widths: startWidths,
          minimumWidths,
          column,
          requestedDelta: latestClientX - startX,
          maximumTotalWidth
        });
        nextWidths = result.widths;
        // Keep the live drag intent available to a replacement widget. A DOM rebuild
        // may otherwise project the last committed width over the active pointer preview.
        storeIntent(table, {
          widths: [...result.widths],
          initialTotalWidth,
          elastic: sum(result.widths) >= maximumTotalWidth - 1,
          defaultWidthWasCapped
        });
        render(table, result.widths, result.totalWidth);
        table.dispatchEvent(
          new CustomEvent(projectionEventName, {
            detail: { resizeRows: false },
          }),
        );
      };

      const removeDragListeners = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        pointerBoundary.removeEventListener('pointerleave', finish);
        pointerBoundary.removeEventListener('lostpointercapture', finish);
        pointerBoundary.classList.remove(resizingClassName);
        if (pointerBoundary.hasPointerCapture?.(event.pointerId)) {
          pointerBoundary.releasePointerCapture(event.pointerId);
        }
        refreshDragPreview = null;
        dragCleanup = null;
      };
      const finish = (finishEvent?: PointerEvent) => {
        if (finishEvent && finishEvent.pointerId !== event.pointerId) return;
        removeDragListeners();
        if (!isCurrentBinding() || !table.isConnected) return;
        const maximumTotalWidth = availableWidth(table);
        storeIntent(table, {
          widths: [...nextWidths],
          initialTotalWidth,
          elastic: sum(nextWidths) >= maximumTotalWidth - 1,
          defaultWidthWasCapped
        });
        table.dispatchEvent(new CustomEvent(projectionEventName));
        scheduleProjection();
      };
      const move = (moveEvent: PointerEvent) => {
        if (!isCurrentBinding() || moveEvent.pointerId !== event.pointerId) return;
        if (moveEvent.pointerType === 'mouse' && (moveEvent.buttons & 1) === 0) {
          finish(moveEvent);
          return;
        }
        moveEvent.preventDefault();
        latestClientX = moveEvent.clientX;
        renderDragPreview();
      };

      refreshDragPreview = renderDragPreview;
      dragCleanup = removeDragListeners;
      pointerBoundary.classList.add(resizingClassName);
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
      pointerBoundary.addEventListener('pointerleave', finish);
      pointerBoundary.addEventListener('lostpointercapture', finish);
      try {
        pointerBoundary.setPointerCapture(event.pointerId);
      } catch {
        // Keep pointerup/cancel/leave fallbacks for hosts that reject capture.
      }
    };

    const handleRoot = table.closest<HTMLElement>('.meo-md-html-table-shell') ?? table;
    handleRoot.addEventListener('pointerdown', start);
    cleanups.push(() => handleRoot.removeEventListener('pointerdown', start));

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(scheduleProjection);
      observer.observe(table.parentElement ?? options.root);
      cleanups.push(() => observer.disconnect());
    }

    return {
      table,
      project: () => project(table, epoch),
      cleanup() {
        if (!lifecycle.alive) return;
        lifecycle.alive = false;
        dragCleanup?.();
        cancelFrame();
        for (const cleanup of cleanups) cleanup();
        delete table.dataset.tableColumnWidthOwner;
      }
    };
  };

  const reconcile = (epoch: LifecycleEpoch): void => {
    if (!isCurrentEpoch(epoch)) return;
    const current = new Set(options.root.querySelectorAll<HTMLTableElement>(tableSelector));
    for (const [table, binding] of bindings) {
      if (current.has(table)) continue;
      binding.cleanup();
      bindings.delete(table);
    }
    for (const table of current) {
      let binding = bindings.get(table);
      if (!binding) {
        binding = bind(table, epoch);
        bindings.set(table, binding);
      }
      binding.project();
    }
  };

  const mapIntents = (update: ViewUpdate): void => {
    if (disposed) return;
    let shouldReconcile = false;
    for (const transaction of update.transactions) {
      if (transaction.docChanged) {
        for (const intent of intents) {
          intent.from = transaction.changes.mapPos(intent.from, 1);
          intent.to = transaction.changes.mapPos(intent.to, 1);
        }
        for (let index = intents.length - 1; index >= 0; index -= 1) {
          if (intents[index].from >= intents[index].to) intents.splice(index, 1);
        }
      }
      if (transaction.docChanged || isLiveInputDerivedWorkRefresh(transaction)) {
        shouldReconcile = true;
      }
    }
    if (shouldReconcile && currentEpoch) {
      const epoch = currentEpoch;
      requestLiveInputDerivedWork(update.view, reconcileConsumer, () => reconcile(epoch));
    }
  };

  const release = (): void => {
    const epoch = currentEpoch;
    if (!epoch) return;
    currentEpoch = null;
    epoch.alive = false;
    mutationObserver?.disconnect();
    mutationObserver = null;
    for (const binding of bindings.values()) binding.cleanup();
    bindings.clear();
  };

  const adapter: TableColumnWidthAdapter = {
    acquire() {
      if (disposed || currentEpoch) return;
      const epoch = { alive: true };
      currentEpoch = epoch;
      mutationObserver = new MutationObserver(() => {
        const view = currentView;
        if (view) requestLiveInputDerivedWork(view, reconcileConsumer, () => reconcile(epoch));
        else reconcile(epoch);
      });
      mutationObserver.observe(options.root, { childList: true, subtree: true });
      reconcile(epoch);
    },
    release,
    dispose() {
      if (disposed) return;
      release();
      disposed = true;
      intents.splice(0, intents.length);
    }
  };

  return {
    adapter,
    extension: ViewPlugin.define((view) => {
      currentView = view;
      return {
        update: mapIntents,
        destroy() {
          if (currentView === view) currentView = null;
        }
      };
    })
  };
}
