export type HistoryScrollSettlementResult = {
  status: 'pending' | 'settled' | 'unsupported';
  listenerCount: number;
};

type BeginHistoryScrollSettlementOptions = {
  lineNumber: number;
  controlsLabel: string;
  registryKey: string;
  supportsScrollEndOverride?: boolean;
};

type HistoryScrollSettlementRegistry = {
  settled: boolean;
  listenerCount: number;
  dispose(): void;
};

export function beginHistoryScrollSettlement({
  lineNumber,
  controlsLabel,
  registryKey,
  supportsScrollEndOverride
}: BeginHistoryScrollSettlementOptions): HistoryScrollSettlementResult {
  const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
  const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${controlsLabel}"]`);
  if (!scroller) throw new Error('Missing editor scroller');
  if (!group) throw new Error(`Missing rendered block controls: ${controlsLabel}`);
  const viewport = scroller.getBoundingClientRect();
  const controls = group.getBoundingClientRect();
  const validGeometry = [viewport.top, viewport.bottom, controls.top, controls.bottom].every(Number.isFinite)
    && viewport.bottom > viewport.top
    && controls.bottom > controls.top;
  if (!validGeometry) {
    throw new Error(`Invalid rendered block geometry: ${JSON.stringify({
      viewport: { top: viewport.top, bottom: viewport.bottom },
      controls: { top: controls.top, bottom: controls.bottom }
    })}`);
  }
  const viewportCenter = (viewport.top + viewport.bottom) / 2;
  const alreadyCentered = controls.top <= viewportCenter && controls.bottom >= viewportCenter;
  if (alreadyCentered) return { status: 'settled', listenerCount: 0 };
  const supportsScrollEnd = supportsScrollEndOverride ?? ('onscrollend' in scroller);
  if (!supportsScrollEnd) return { status: 'unsupported', listenerCount: 0 };
  const registry = window as unknown as Record<string, HistoryScrollSettlementRegistry | undefined>;
  const onScrollEnd = () => {
    transaction.settled = true;
    transaction.dispose();
  };
  const transaction: HistoryScrollSettlementRegistry = {
    settled: false,
    listenerCount: 1,
    dispose() {
      if (transaction.listenerCount === 0) return;
      scroller.removeEventListener('scrollend', onScrollEnd);
      transaction.listenerCount = 0;
    }
  };
  registry[registryKey] = transaction;
  scroller.addEventListener('scrollend', onScrollEnd);
  try {
    (window as any).__historyMatrixEditor.scrollToLine(lineNumber, 'center');
  } catch (error) {
    transaction.dispose();
    delete registry[registryKey];
    throw error;
  }
  return {
    status: transaction.settled ? 'settled' : 'pending',
    listenerCount: transaction.listenerCount
  };
}

export function disposeHistoryScrollSettlement(registryKey: string): number {
  const registry = window as unknown as Record<string, HistoryScrollSettlementRegistry | undefined>;
  const transaction = registry[registryKey];
  transaction?.dispose();
  const listenerCount = transaction?.listenerCount ?? 0;
  delete registry[registryKey];
  return listenerCount;
}
