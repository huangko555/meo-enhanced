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
import { isExternalDocumentPresentation } from './externalDocumentPresentation';

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
  /** Latest manual column proportions; container projections must not redefine them. */
  readonly intentWidths: readonly number[];
  readonly minimumWidths: readonly number[];
  readonly availableWidth: number;
  readonly policyState: TableColumnWidthPolicyState;
  readonly preferredTotalWidth: number;
};

type WidthIntent = {
  from: number;
  to: number;
  table: HTMLTableElement;
  signature: string | null;
  snapshot: PreviewSnapshot;
};

type StartupBaseline = {
  from: number;
  to: number;
  table: HTMLTableElement;
  signature: string | null;
  widths: readonly number[];
  totalWidth: number;
};

type TableBinding = {
  readonly table: HTMLTableElement;
  readonly cleanup: () => void;
  project(): 'changed' | 'drag-pending' | 'stable';
};

type LifecycleEpoch = {
  alive: boolean;
  readonly projectionConsumer: object;
};

const tableSelector = 'table[data-table-column-width]';
const handleSelector = '[data-table-resize-column]';
const projectionEventName = 'meo-table-column-width-projected';
const columnPermutationEventName = 'meo-table-column-permutation';
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
  const startupBaselines: StartupBaseline[] = [];
  const bindings = new Map<HTMLTableElement, TableBinding>();
  let mutationObserver: MutationObserver | null = null;
  let currentEpoch: LifecycleEpoch | null = null;
  let currentView: EditorView | null = null;
  let disposed = false;
  let listensForColumnPermutation = false;
  let reconcile: (epoch: LifecycleEpoch, notifyPendingDrag?: boolean) => void;

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

  const findIntent = (table: HTMLTableElement, allowSignatureFallback = false): WidthIntent | null => {
    const from = numberFromDataset(table, 'tableFrom');
    const to = numberFromDataset(table, 'tableTo');
    if (from === null || to === null) return null;
    const columnCount = table.querySelectorAll('thead th').length;
    const exact = intents.find((intent) => (
      intent.from === from && intent.to === to && intent.snapshot.widths.length === columnCount
    ));
    if (exact) return exact;
    if (!allowSignatureFallback) return null;
    const signature = table.dataset.tableSignature;
    if (!signature) return null;
    return intents
      .filter((intent) => (
        intent.signature === signature
        && intent.snapshot.widths.length === columnCount
        && Math.abs(intent.from - from) <= 8
        && (!intent.table.isConnected || intent.table === table)
      ))
      .sort((left, right) => (
        Number(right.table === table) - Number(left.table === table)
        || Math.abs(left.from - from) - Math.abs(right.from - from)
      ))[0] ?? null;
  };

  const availableWidth = (table: HTMLTableElement): number => {
    const container = table.parentElement ?? options.root;
    const style = getComputedStyle(container);
    const numeric = (value: string) => Number.parseFloat(value) || 0;
    const borderWidth = numeric(style.borderLeftWidth) + numeric(style.borderRightWidth);
    const paddingWidth = numeric(style.paddingLeft) + numeric(style.paddingRight);
    const scrollbarWidth = Math.max(0, container.offsetWidth - container.clientWidth - borderWidth);
    const contentWidth = container.getBoundingClientRect().width
      - borderWidth
      - paddingWidth
      - scrollbarWidth;
    return Math.max(0, contentWidth - tableCollapsedOuterBorderWidth(table));
  };

  const findStartupBaseline = (table: HTMLTableElement): StartupBaseline | null => {
    const from = numberFromDataset(table, 'tableFrom');
    const to = numberFromDataset(table, 'tableTo');
    if (from === null || to === null) return null;
    const columnCount = table.querySelectorAll('thead th').length;
    const exact = startupBaselines.find((baseline) => (
      baseline.from === from && baseline.to === to && baseline.widths.length === columnCount
    ));
    if (exact) return exact;
    const signature = table.dataset.tableSignature;
    if (!signature) return null;
    return startupBaselines
      .filter((baseline) => baseline.signature === signature && baseline.widths.length === columnCount)
      .sort((left, right) => Math.abs(left.from - from) - Math.abs(right.from - from))[0] ?? null;
  };

  const acquireStartupBaseline = (table: HTMLTableElement): StartupBaseline | null => {
    const existing = findStartupBaseline(table);
    if (existing) {
      const from = numberFromDataset(table, 'tableFrom');
      const to = numberFromDataset(table, 'tableTo');
      if (from !== null && to !== null) {
        existing.from = from;
        existing.to = to;
        existing.table = table;
        existing.signature = table.dataset.tableSignature ?? null;
      }
      return existing;
    }
    const from = numberFromDataset(table, 'tableFrom');
    const to = numberFromDataset(table, 'tableTo');
    if (from === null || to === null) return null;
    const widths = Array.from(table.querySelectorAll<HTMLElement>('thead th'))
      .map((cell) => cell.getBoundingClientRect().width);
    if (!widths.length || widths.some((width) => !Number.isFinite(width) || width <= 0)) return null;
    const baseline: StartupBaseline = {
      from,
      to,
      table,
      signature: table.dataset.tableSignature ?? null,
      widths,
      totalWidth: widths.reduce((sum, width) => sum + width, 0)
    };
    startupBaselines.push(baseline);
    return baseline;
  };

  const refreshUncommittedStartupBaseline = (table: HTMLTableElement): StartupBaseline | null => {
    const baseline = acquireStartupBaseline(table);
    if (!baseline) return null;
    const widths = Array.from(table.querySelectorAll<HTMLElement>('thead th'))
      .map((cell) => cell.getBoundingClientRect().width);
    if (!widths.length || widths.some((width) => !Number.isFinite(width) || width <= 0)) return baseline;
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    // A virtualized table may first enter the DOM while the document is narrow.
    // Before the first user width intent, retain the widest natural layout seen;
    // later container shrinkage must not redefine the restoration ceiling.
    if (totalWidth > baseline.totalWidth + 0.5) {
      baseline.widths = widths;
      baseline.totalWidth = totalWidth;
    }
    return baseline;
  };

  const setOverflowState = (table: HTMLTableElement, maximumWidth: number): void => {
    const minimumTotalWidth = minimumWidths(table).reduce((sum, width) => sum + width, 0);
    table.parentElement?.classList.toggle(
      'is-table-overflowing',
      minimumTotalWidth > maximumWidth + 0.5
    );
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
    stickyTable.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    stickyTable.style.maxWidth = 'none';
    stickyTable.style.minWidth = '0';
    stickyTable.style.tableLayout = 'fixed';
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
    setOverflowState(table, availableWidth(table));
  };

  const reset = (table: HTMLTableElement): void => {
    table.style.width = '';
    table.style.maxWidth = '';
    table.style.minWidth = '';
    table.style.tableLayout = '';
    table.parentElement?.classList.remove('is-table-overflowing');
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
    const intent = findIntent(table, true);
    if (!intent) {
      reset(table);
      const startupBaseline = refreshUncommittedStartupBaseline(table);
      const currentFacts = layoutFacts(table);
      const currentTotalWidth = currentFacts.widths.reduce((sum, width) => sum + width, 0);
      const minimumTotalWidth = currentFacts.minimumWidths.reduce((sum, width) => sum + width, 0);
      const canFitReadableColumns = minimumTotalWidth <= currentFacts.availableWidth + 0.5;
      if (startupBaseline && currentFacts.availableWidth > 0
        && currentTotalWidth > currentFacts.availableWidth + 0.5
        && canFitReadableColumns) {
        const result = policy.project({
          widths: currentFacts.widths,
          minimumWidths: currentFacts.minimumWidths,
          initialTotalWidth: startupBaseline.totalWidth,
          maximumTrackedWidth: startupBaseline.totalWidth,
          defaultWidthWasCapped: true,
          availableWidth: currentFacts.availableWidth,
          preserveWidthIntent: false,
          elastic: true,
          tracksAvailableWidth: true
        });
        render(table, result.widths, result.totalWidth);
        storeIntent(table, {
          snapshot: {
            widths: [...result.widths],
            intentWidths: [...startupBaseline.widths],
            minimumWidths: [...currentFacts.minimumWidths],
            availableWidth: currentFacts.availableWidth,
            policyState: result.elastic
              ? { elastic: true, tracksAvailableWidth: result.tracksAvailableWidth }
              : { elastic: false, tracksAvailableWidth: false },
            preferredTotalWidth: startupBaseline.totalWidth
          }
        });
        return;
      }
      setOverflowState(table, currentFacts.availableWidth);
      return;
    }
    const currentFacts = layoutFacts(table);
    const currentPolicyState: TableColumnWidthPolicyState = intent.snapshot.policyState.elastic
      ? {
          elastic: true,
          tracksAvailableWidth: intent.snapshot.policyState.tracksAvailableWidth
        }
      : { elastic: false, tracksAvailableWidth: false };
    const preserveWidthIntent = sameLayoutFacts(intent.snapshot, currentFacts);
    const projectionWidths = currentPolicyState.tracksAvailableWidth && !preserveWidthIntent
      ? intent.snapshot.intentWidths
      : currentFacts.widths;
    const result = policy.project({
      widths: projectionWidths,
      minimumWidths: currentFacts.minimumWidths,
      initialTotalWidth: intent.snapshot.preferredTotalWidth,
      maximumTrackedWidth: intent.snapshot.preferredTotalWidth,
      defaultWidthWasCapped: false,
      availableWidth: currentFacts.availableWidth,
      preserveWidthIntent,
      ...currentPolicyState
    });
    render(table, result.widths, result.totalWidth);
    intent.table = table;
    intent.signature = table.dataset.tableSignature ?? null;
    intent.snapshot = {
      widths: [...result.widths],
      intentWidths: [...intent.snapshot.intentWidths],
      minimumWidths: [...currentFacts.minimumWidths],
      availableWidth: currentFacts.availableWidth,
      policyState: result.elastic
        ? {
            elastic: true,
            tracksAvailableWidth: result.tracksAvailableWidth
          }
        : { elastic: false, tracksAvailableWidth: false },
      preferredTotalWidth: intent.snapshot.preferredTotalWidth
    };
  };

  const storeIntent = (
    table: HTMLTableElement,
    next: Omit<WidthIntent, 'from' | 'to' | 'table' | 'signature'>
  ): void => {
    const from = numberFromDataset(table, 'tableFrom');
    const to = numberFromDataset(table, 'tableTo');
    if (from === null || to === null || disposed) return;
    const existing = intents.findIndex((intent) => intent.from === from && intent.to === to);
    const value = {
      from,
      to,
      table,
      signature: table.dataset.tableSignature ?? null,
      ...next
    };
    if (existing >= 0) intents[existing] = value;
    else intents.push(value);
  };

  const applyColumnPermutation = (event: Event) => {
    const table = event instanceof CustomEvent ? event.detail?.table : null;
    const permutation = event instanceof CustomEvent ? event.detail?.permutation : null;
    if (!(table instanceof HTMLTableElement)) return;
    const columnCount = table.querySelectorAll('thead th').length;
    if (!Array.isArray(permutation) || permutation.length !== columnCount ||
      permutation.some((index) => !Number.isInteger(index) || index < 0 || index >= columnCount) ||
      new Set(permutation).size !== columnCount) return;
    const permute = <T>(values: readonly T[]) => permutation.map((index) => values[index]);
    const intent = findIntent(table, true);
    if (intent) {
      intent.snapshot = {
        ...intent.snapshot,
        widths: permute(intent.snapshot.widths),
        intentWidths: permute(intent.snapshot.intentWidths),
        minimumWidths: permute(intent.snapshot.minimumWidths)
      };
    }
    const baseline = findStartupBaseline(table);
    if (baseline) baseline.widths = permute(baseline.widths);
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
    acquireStartupBaseline(table);
    const committedIntent = findIntent(table, true);
    if (committedIntent) {
      const currentFrom = numberFromDataset(table, 'tableFrom');
      const currentTo = numberFromDataset(table, 'tableTo');
      if (currentFrom !== null && currentTo !== null) {
        committedIntent.from = currentFrom;
        committedIntent.to = currentTo;
        committedIntent.table = table;
        committedIntent.signature = table.dataset.tableSignature ?? null;
      }
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
      const startupBaseline = acquireStartupBaseline(table);
      const startFacts = layoutFacts(table);
      const initialTotalWidth = table.getBoundingClientRect().width;
      const preferredTotalWidth = stored?.snapshot.preferredTotalWidth
        ?? startupBaseline?.totalWidth
        ?? Math.max(initialTotalWidth, table.scrollWidth);
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
        const requestedDelta = latestClientX - startX;
        const snapshot: PreviewSnapshot = {
          widths: [...result.widths],
          // A drag is the only operation that changes the user's preferred
          // proportions. Elastic container projections scale this basis but
          // leave it intact, while the startup total remains the growth cap.
          intentWidths: [...result.widths],
          minimumWidths: [...facts.minimumWidths],
          availableWidth: facts.availableWidth,
          policyState: result.elastic
            ? {
                elastic: true,
                tracksAvailableWidth: result.tracksAvailableWidth
              }
            : { elastic: false, tracksAvailableWidth: false },
          preferredTotalWidth
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
    // Capture before the passive Sticky Header layer can consume cloned-cell events.
    handleRoot.addEventListener('pointerdown', start, true);
    cleanups.push(() => handleRoot.removeEventListener('pointerdown', start, true));

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
          projectedContainerWidth = availableWidth(table);
          return 'drag-pending';
        }
        const beforeWidths = Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width);
        const beforeTotalWidth = table.getBoundingClientRect().width;
        project(table, epoch);
        dragLayoutFactsDirty = false;
        projectedContainerWidth = availableWidth(table);
        const afterWidths = Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width);
        const afterTotalWidth = table.getBoundingClientRect().width;
        const changed = previousContainerWidth === null
          || Math.round(previousContainerWidth) !== Math.round(projectedContainerWidth)
          || Math.abs(afterTotalWidth - beforeTotalWidth) >= 1
          || afterWidths.some((width, index) => Math.abs(width - (beforeWidths[index] ?? 0)) >= 1);
        return changed ? 'changed' : 'stable';
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

  reconcile = (epoch: LifecycleEpoch, notifyPendingDrag = false): void => {
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
      const projection = binding.project();
      if (isNewBinding || projection === 'changed' || (notifyPendingDrag && projection === 'drag-pending')) {
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
          const mappedFrom = transaction.changes.mapPos(intent.from, 1);
          const mappedTo = transaction.changes.mapPos(intent.to, 1);
          if (isExternalDocumentPresentation(transaction)
            && intent.table.isConnected && options.root.contains(intent.table)) {
            const currentFrom = numberFromDataset(intent.table, 'tableFrom');
            const currentTo = numberFromDataset(intent.table, 'tableTo');
            if (currentFrom !== null && currentTo !== null) {
              // ViewPlugin updates can run before or after a retained table
              // widget refreshes its source metadata. Adopt refreshed metadata
              // when it has moved; otherwise map the still-stale DOM range
              // through this transaction so a replacement can recover the
              // same width intent by its new document position.
              const metadataWasRefreshed = currentFrom !== intent.from || currentTo !== intent.to;
              intent.from = metadataWasRefreshed ? currentFrom : mappedFrom;
              intent.to = metadataWasRefreshed ? currentTo : mappedTo;
              continue;
            }
          }
          intent.from = mappedFrom;
          intent.to = mappedTo;
        }
        for (const baseline of startupBaselines) {
          baseline.from = transaction.changes.mapPos(baseline.from, 1);
          baseline.to = transaction.changes.mapPos(baseline.to, 1);
        }
        for (let index = intents.length - 1; index >= 0; index -= 1) {
          if (intents[index].from >= intents[index].to) intents.splice(index, 1);
        }
        for (let index = startupBaselines.length - 1; index >= 0; index -= 1) {
          if (startupBaselines[index].from >= startupBaselines[index].to) startupBaselines.splice(index, 1);
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
    if (listensForColumnPermutation) {
      options.root.removeEventListener(columnPermutationEventName, applyColumnPermutation);
      listensForColumnPermutation = false;
    }
  };

  const adapter: TableColumnWidthAdapter = {
    acquire() {
      if (disposed || currentEpoch) return;
      options.root.addEventListener(columnPermutationEventName, applyColumnPermutation);
      listensForColumnPermutation = true;
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
      startupBaselines.splice(0, startupBaselines.length);
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
