import type { Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import {
  tableColumnWidthPolicy,
  type TableColumnWidthPolicy
} from './tableColumnWidthPolicy';

export type TableColumnWidthAdapter = {
  refresh(): void;
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

const tableSelector = 'table[data-table-column-width]';
const handleSelector = '[data-table-resize-column]';
const projectionEventName = 'meo-table-column-width-projected';

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
  let disposed = false;

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

  const project = (table: HTMLTableElement): void => {
    if (disposed) return;
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

  const bind = (table: HTMLTableElement): TableBinding => {
    const cleanups: Array<() => void> = [];
    let dragCleanup: (() => void) | null = null;
    let resizeFrame = 0;
    table.dataset.tableColumnWidthOwner = 'adapter';

    const cancelFrame = () => {
      if (!resizeFrame) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
    };
    const scheduleProjection = () => {
      if (disposed || resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        project(table);
        table.dispatchEvent(new CustomEvent(projectionEventName));
      });
    };

    const start = (event: PointerEvent): void => {
      if (disposed || event.button !== 0) return;
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
      const pointerBoundary = table.closest<HTMLElement>('.cm-editor') ?? options.root;

      const removeDragListeners = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        pointerBoundary.removeEventListener('pointerleave', finish);
        dragCleanup = null;
      };
      const finish = (finishEvent?: PointerEvent) => {
        if (finishEvent && finishEvent.pointerId !== event.pointerId) return;
        removeDragListeners();
        if (disposed || !table.isConnected) return;
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
        if (moveEvent.pointerId !== event.pointerId) return;
        if (moveEvent.pointerType === 'mouse' && (moveEvent.buttons & 1) === 0) {
          finish(moveEvent);
          return;
        }
        moveEvent.preventDefault();
        const result = policy.resize({
          widths: startWidths,
          minimumWidths,
          column,
          requestedDelta: moveEvent.clientX - startX,
          maximumTotalWidth: availableWidth(table)
        });
        nextWidths = result.widths;
        render(table, result.widths, result.totalWidth);
      };

      dragCleanup = removeDragListeners;
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
      pointerBoundary.addEventListener('pointerleave', finish);
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
      project: () => project(table),
      cleanup() {
        dragCleanup?.();
        cancelFrame();
        for (const cleanup of cleanups) cleanup();
        delete table.dataset.tableColumnWidthOwner;
      }
    };
  };

  const refresh = (): void => {
    if (disposed) return;
    const current = new Set(options.root.querySelectorAll<HTMLTableElement>(tableSelector));
    for (const [table, binding] of bindings) {
      if (current.has(table)) continue;
      binding.cleanup();
      bindings.delete(table);
    }
    for (const table of current) {
      let binding = bindings.get(table);
      if (!binding) {
        binding = bind(table);
        bindings.set(table, binding);
      }
      binding.project();
    }
  };

  const mapIntents = (update: ViewUpdate): void => {
    if (!update.docChanged || disposed) return;
    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue;
      for (const intent of intents) {
        intent.from = transaction.changes.mapPos(intent.from, 1);
        intent.to = transaction.changes.mapPos(intent.to, 1);
      }
      for (let index = intents.length - 1; index >= 0; index -= 1) {
        if (intents[index].from >= intents[index].to) intents.splice(index, 1);
      }
    }
    refresh();
  };

  const mutationObserver = new MutationObserver(refresh);
  mutationObserver.observe(options.root, { childList: true, subtree: true });

  const adapter: TableColumnWidthAdapter = {
    refresh() {
      if (disposed) return;
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mutationObserver.disconnect();
      intents.splice(0, intents.length);
      for (const binding of bindings.values()) binding.cleanup();
      bindings.clear();
    }
  };

  return {
    adapter,
    extension: EditorView.updateListener.of(mapIntents)
  };
}
