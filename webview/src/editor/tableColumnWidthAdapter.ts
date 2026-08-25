import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import {
  tableColumnWidthPolicy,
  type TableColumnWidthPolicyState,
  type TableColumnWidthPolicy
} from './tableColumnWidthPolicy';
import {
  isLiveInputDerivedWorkRefresh,
  requestLiveInputDerivedWork,
  requestLiveInputDerivedWorkOnFrame
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

type TableLayoutFacts = {
  readonly widths: readonly number[];
  readonly availableWidth: number;
  readonly minimumWidths: readonly number[];
};

type PreviewSnapshot = {
  readonly widths: readonly number[];
  readonly minimumWidths: readonly number[];
  readonly availableWidth: number;
  readonly policyState: TableColumnWidthPolicyState;
};

type WidthIntent = {
  from: number;
  to: number;
  snapshot: PreviewSnapshot;
};

type TableBinding = {
  readonly table: HTMLTableElement;
  readonly cleanup: () => void;
  project(): boolean;
};

type LifecycleEpoch = {
  alive: boolean;
  readonly projectionConsumer: object;
};

const tableSelector = 'table[data-table-column-width]';
const handleSelector = '[data-table-resize-column]';
const projectionEventName = 'meo-table-column-width-projected';
const resizingClassName = 'meo-table-column-resizing';

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
  let reconcile: (epoch: LifecycleEpoch, forceProjectionEvent?: boolean) => void;

  const isCurrentEpoch = (epoch: LifecycleEpoch): boolean => (
    !disposed && epoch.alive && currentEpoch === epoch
  );

  const requestCurrentProjection = (epoch: LifecycleEpoch): void => {
    const operation = () => reconcile(epoch);
    const view = currentView;
    if (view) requestLiveInputDerivedWork(view, epoch.projectionConsumer, operation);
    else operation();
  };

  const requestCurrentProjectionOnFrame = (epoch: LifecycleEpoch): void => {
    const operation = () => reconcile(epoch, true);
    const view = currentView;
    if (view) requestLiveInputDerivedWorkOnFrame(view, epoch.projectionConsumer, operation);
    else requestAnimationFrame(operation);
  };

  const findIntent = (table: HTMLTableElement): WidthIntent | null => {
    const from = numberFromDataset(table, 'tableFrom');
    const to = numberFromDataset(table, 'tableTo');
    if (from === null || to === null) return null;
    const columnCount = table.querySelectorAll('thead th').length;
    return intents.find((intent) => (
      intent.from === from && intent.to === to && intent.snapshot.widths.length === columnCount
    )) ?? null;
  };

  const availableWidth = (table: HTMLTableElement): number => {
    const container = table.parentElement ?? options.root;
    return Math.max(0, container.clientWidth - tableCollapsedOuterBorderWidth(table));
  };

  const minimumWidths = (table: HTMLTableElement): readonly number[] => (
    Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => {
      const cellStyle = getComputedStyle(cell);
      const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
      const previewStyle = preview ? getComputedStyle(preview) : cellStyle;
      const numeric = (value: string) => Number.parseFloat(value) || 0;
      return numeric(previewStyle.fontSize)
        + numeric(previewStyle.paddingLeft)
        + numeric(previewStyle.paddingRight)
        + numeric(cellStyle.borderLeftWidth)
        + numeric(cellStyle.borderRightWidth);
    })
  );

  const layoutFacts = (table: HTMLTableElement): TableLayoutFacts => ({
    widths: Array.from(table.querySelectorAll<HTMLElement>('thead th'))
      .map((cell) => cell.getBoundingClientRect().width),
    availableWidth: availableWidth(table),
    minimumWidths: minimumWidths(table)
  });

  const sameLayoutFacts = (left: TableLayoutFacts, right: TableLayoutFacts): boolean => (
    left.widths.length === right.widths.length
    && left.widths.every((width, index) => Math.abs(width - right.widths[index]) < 1)
    && Math.abs(left.availableWidth - right.availableWidth) < 1
    && left.minimumWidths.length === right.minimumWidths.length
    && left.minimumWidths.every((width, index) => width === right.minimumWidths[index])
  );

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
    const currentFacts = layoutFacts(table);
    const currentPolicyState: TableColumnWidthPolicyState = intent.snapshot.policyState.elastic
      ? {
          elastic: true,
          tracksAvailableWidth: intent.snapshot.policyState.tracksAvailableWidth
        }
      : { elastic: false, tracksAvailableWidth: false };
    const result = policy.project({
      widths: currentFacts.widths,
      minimumWidths: currentFacts.minimumWidths,
      initialTotalWidth: currentFacts.widths.reduce((sum, width) => sum + width, 0),
      defaultWidthWasCapped: false,
      availableWidth: currentFacts.availableWidth,
      preserveWidthIntent: sameLayoutFacts(intent.snapshot, currentFacts),
      ...currentPolicyState
    });
    render(table, result.widths, result.totalWidth);
    storeIntent(table, {
      snapshot: {
        widths: [...result.widths],
        minimumWidths: [...currentFacts.minimumWidths],
        availableWidth: currentFacts.availableWidth,
        policyState: result.elastic
          ? {
              elastic: true,
              tracksAvailableWidth: result.tracksAvailableWidth
            }
          : { elastic: false, tracksAvailableWidth: false }
      }
    });
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
    let dragPreviewActive = false;
    let dragLayoutFactsDirty = false;
    let initialResizePending = true;
    let projectedContainerWidth: number | null = null;
    table.dataset.tableColumnWidthOwner = 'adapter';
    const committedIntent = findIntent(table);
    if (committedIntent) {
      // A replacement first restores the committed presentation. Policy then
      // receives freshly measured DOM facts; stored layout fields never enter its request.
      render(
        table,
        committedIntent.snapshot.widths,
        committedIntent.snapshot.widths.reduce((sum, width) => sum + width, 0)
      );
    }

    const isCurrentBinding = () => lifecycle.alive
      && isCurrentEpoch(epoch)
      && table.isConnected
      && options.root.contains(table);
    const scheduleProjection = (entries: readonly ResizeObserverEntry[]) => {
      if (!isCurrentBinding()) return;
      // observe() always delivers the current size once. The binding was
      // projected by the same reconcile leaf, so that notification is not a
      // second invalidation.
      if (initialResizePending) {
        initialResizePending = false;
        const observedWidth = entries[0]?.contentRect.width;
        if (projectedContainerWidth !== null && observedWidth !== undefined
          && Math.round(observedWidth) === Math.round(projectedContainerWidth)) return;
      }
      requestCurrentProjectionOnFrame(epoch);
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
      const startFacts = layoutFacts(table);
      const initialTotalWidth = table.getBoundingClientRect().width;
      const startMaximumTotalWidth = availableWidth(table);
      const defaultWidthWasCapped = initialTotalWidth >= startMaximumTotalWidth - 1;
      let startPolicyState: TableColumnWidthPolicyState;
      if (stored?.snapshot.policyState.elastic) {
        startPolicyState = {
          elastic: true,
          tracksAvailableWidth: stored.snapshot.policyState.tracksAvailableWidth
        };
      } else if (stored) startPolicyState = { elastic: false, tracksAvailableWidth: false };
      else if (defaultWidthWasCapped) startPolicyState = { elastic: true, tracksAvailableWidth: true };
      else startPolicyState = { elastic: false, tracksAvailableWidth: false };
      const startX = event.clientX;
      let lastPreview: PreviewSnapshot | null = null;
      let latestClientX = startX;
      const pointerBoundary = table.closest<HTMLElement>('.cm-editor') ?? options.root;
      dragLayoutFactsDirty = false;

      const renderDragPreview = (): void => {
        if (!isCurrentBinding()) return;
        const facts = layoutFacts(table);
        const result = policy.resize({
          widths: startFacts.widths,
          minimumWidths: facts.minimumWidths,
          column,
          requestedDelta: latestClientX - startX,
          maximumTotalWidth: facts.availableWidth,
          ...startPolicyState
        });
        const snapshot: PreviewSnapshot = {
          widths: [...result.widths],
          minimumWidths: [...facts.minimumWidths],
          availableWidth: facts.availableWidth,
          policyState: result.elastic
            ? {
                elastic: true,
                tracksAvailableWidth: result.tracksAvailableWidth
              }
            : { elastic: false, tracksAvailableWidth: false }
        };
        lastPreview = snapshot;
        // Keep the live drag intent available to a replacement widget. A DOM rebuild
        // may otherwise project the last committed width over the active pointer preview.
        storeIntent(table, {
          snapshot
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
        dragPreviewActive = false;
        dragCleanup = null;
      };
      const finish = (finishEvent?: PointerEvent) => {
        if (finishEvent && finishEvent.pointerId !== event.pointerId) return;
        removeDragListeners();
        if (!isCurrentBinding() || !table.isConnected) return;
        const committedSnapshot = lastPreview ?? stored?.snapshot ?? null;
        if (lastPreview) {
          storeIntent(table, {
            snapshot: lastPreview
          });
          table.dispatchEvent(new CustomEvent(projectionEventName));
        }
        const currentFacts = layoutFacts(table);
        const needsReconcile = committedSnapshot !== null
          && (dragLayoutFactsDirty || !sameLayoutFacts(committedSnapshot, currentFacts));
        dragLayoutFactsDirty = needsReconcile;
        if (needsReconcile) {
          requestCurrentProjectionOnFrame(epoch);
        }
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

      dragPreviewActive = true;
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
      project() {
        const previousContainerWidth = projectedContainerWidth;
        if (dragPreviewActive) {
          const intent = findIntent(table);
          if (intent && !sameLayoutFacts(intent.snapshot, layoutFacts(table))) {
            dragLayoutFactsDirty = true;
          }
          projectedContainerWidth = (table.parentElement ?? options.root).clientWidth;
          return false;
        }
        project(table, epoch);
        dragLayoutFactsDirty = false;
        projectedContainerWidth = (table.parentElement ?? options.root).clientWidth;
        return previousContainerWidth === null
          || Math.round(previousContainerWidth) !== Math.round(projectedContainerWidth);
      },
      cleanup() {
        if (!lifecycle.alive) return;
        lifecycle.alive = false;
        dragCleanup?.();
        for (const cleanup of cleanups) cleanup();
        delete table.dataset.tableColumnWidthOwner;
      }
    };
  };

  reconcile = (epoch: LifecycleEpoch, forceProjectionEvent = false): void => {
    if (!isCurrentEpoch(epoch)) return;
    const current = new Set(options.root.querySelectorAll<HTMLTableElement>(tableSelector));
    for (const [table, binding] of bindings) {
      if (current.has(table)) continue;
      binding.cleanup();
      bindings.delete(table);
    }
    for (const table of current) {
      let binding = bindings.get(table);
      const isNewBinding = !binding;
      if (!binding) {
        binding = bind(table, epoch);
        bindings.set(table, binding);
      }
      if (!isCurrentEpoch(epoch) || !table.isConnected || !options.root.contains(table)) continue;
      const projectionChanged = binding.project();
      if (forceProjectionEvent || isNewBinding || projectionChanged) {
        table.dispatchEvent(new CustomEvent(projectionEventName));
      }
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
      requestCurrentProjection(currentEpoch);
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
      const epoch = { alive: true, projectionConsumer: {} };
      currentEpoch = epoch;
      mutationObserver = new MutationObserver(() => {
        requestCurrentProjection(epoch);
      });
      mutationObserver.observe(options.root, { childList: true, subtree: true });
      requestCurrentProjection(epoch);
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
