import type { EditorView } from '@codemirror/view';
import { getViewportController, type ElementTopRetention } from './viewportController';

const retentions = new WeakMap<HTMLTableElement, ElementTopRetention>();

export function beginTableColumnResizeViewport(
  view: EditorView, table: HTMLTableElement, isCurrent: () => boolean
): void {
  retentions.get(table)?.cancel();
  retentions.delete(table);
  const controller = getViewportController(view);
  if (!controller || controller.isUserScrolling()) return;
  const viewport = view.scrollDOM.getBoundingClientRect();
  const sticky = table.closest('.meo-md-html-table-shell')
    ?.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome')?.getBoundingClientRect();
  const visibleTop = Math.max(viewport.top, sticky?.height ? sticky.bottom : viewport.top);
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > visibleTop && rect.top < viewport.bottom;
  };
  const active = table.ownerDocument.activeElement;
  let anchor: HTMLElement | undefined;
  if (active instanceof HTMLTextAreaElement && table.contains(active) && visible(active)) anchor = active;
  else {
    const rows = Array.from(table.tBodies[0]?.rows ?? []).filter(row => !row.classList.contains('meo-table-row-gap'));
    // Large tables may retain many mounted rows for accessibility. Read geometry
    // logarithmically, rather than force layout for every row at gesture start.
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle]!.getBoundingClientRect().bottom <= visibleTop) low = middle + 1;
      else high = middle;
    }
    if (rows[low] && visible(rows[low]!)) anchor = rows[low];
  }
  if (!anchor) return;
  const reference = anchor;
  const retention = controller.retainElementTop(reference, () => reference.isConnected ? reference : null,
    () => table.isConnected && reference.isConnected && isCurrent() && !controller.isUserScrolling());
  if (!retention) return;
  const window = table.ownerDocument.defaultView;
  const finish = () => {
    window?.removeEventListener('blur', finish);
    retention.finish();
  };
  retentions.set(table, { ...retention, finish, cancel() {
    window?.removeEventListener('blur', finish);
    retention.cancel();
  } });
  window?.addEventListener('blur', finish, { once: true });
}

/** Correct in the same layout checkpoint; deferred measurements use this owner too. */
export function preserveTableColumnResizeLayout(table: HTMLTableElement, mutate: () => void): boolean {
  const retention = retentions.get(table);
  if (!retention) return false;
  if (!retention.isCurrent()) {
    retention.cancel();
    retentions.delete(table);
    return false;
  }
  mutate();
  retention.correct();
  return true;
}

export function finishTableColumnResizeViewport(table: HTMLTableElement): void {
  retentions.get(table)?.finish();
}
