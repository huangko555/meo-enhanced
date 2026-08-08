import type { Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import {
  tableColumnWidthPolicy,
  type TableColumnWidthPolicy
} from './tableColumnWidthPolicy';

export type TableColumnWidthAdapterInput =
  | { readonly type: 'refresh' }
  | { readonly type: 'externalDocumentPresented' };

export type TableColumnWidthAdapter = {
  accept(input: TableColumnWidthAdapterInput): void;
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
  reset(): void;
};

const tableSelector = 'table[data-table-column-width]';
const handleSelector = '[data-table-column-width-handle]';

function sum(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

function numberFromDataset(element: HTMLElement, key: 'tableFrom' | 'tableTo'): number | null {
  const value = Number(element.dataset[key]);
  return Number.isFinite(value) ? value : null;
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
    return Math.max(0, container.clientWidth);
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
  };

  const reset = (table: HTMLTableElement): void => {
    table.style.width = '';
    table.style.maxWidth = '';
    table.style.minWidth = '';
    table.style.tableLayout = '';
    for (const column of table.querySelectorAll<HTMLTableColElement>('colgroup > col')) {
      column.style.width = '';
    }
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
      });
    };

    const start = (event: PointerEvent): void => {
      if (disposed || event.button !== 0) return;
      const handle = event.currentTarget;
      if (!(handle instanceof HTMLElement)) return;
      const column = Number(handle.dataset.tableColumnWidthHandle);
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
        const style = getComputedStyle(cell);
        const numeric = (value: string) => Number.parseFloat(value) || 0;
        return numeric(style.fontSize) + numeric(style.paddingLeft) + numeric(style.paddingRight)
          + numeric(style.borderLeftWidth) + numeric(style.borderRightWidth);
      });
      const startX = event.clientX;
      let nextWidths: readonly number[] = startWidths;

      const removeDragListeners = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        options.root.removeEventListener('pointerleave', finish);
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
      options.root.addEventListener('pointerleave', finish);
    };

    for (const handle of table.querySelectorAll<HTMLElement>(handleSelector)) {
      handle.addEventListener('pointerdown', start);
      cleanups.push(() => handle.removeEventListener('pointerdown', start));
    }

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(scheduleProjection);
      observer.observe(table.parentElement ?? options.root);
      cleanups.push(() => observer.disconnect());
    }

    return {
      table,
      project: () => project(table),
      reset: () => reset(table),
      cleanup() {
        dragCleanup?.();
        cancelFrame();
        for (const cleanup of cleanups) cleanup();
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
        intent.to = transaction.changes.mapPos(intent.to, -1);
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
    accept(input) {
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
