import type { PreviewDocumentManifest, PreviewDocumentOperation, PreviewDocumentResult,
  PreviewDocumentMatch } from '../../../src/foundation/previewDocument';
import type { SearchMatchAnchor } from '../application/searchMatchAnchor';
import type { createPreviewSearchController } from './previewSearch';
import type { createPreviewViewport } from './previewViewport';

type SearchOptions = { wholeWord?: boolean; caseSensitive?: boolean };
type SearchResult = Extract<PreviewDocumentResult, { kind: 'search' }>;

/** Full-document matches live in the parser worker; only current DOM receives marks. */
export function createPreviewDocumentSearch(manifest: PreviewDocumentManifest, dependencies: {
  getDocument(): Document | null;
  visible: ReturnType<typeof createPreviewSearchController>;
  viewport: ReturnType<typeof createPreviewViewport>;
  request(documentId: string, operation: PreviewDocumentOperation): Promise<PreviewDocumentResult>;
  isVisible(): boolean;
  onNavigate(): void;
  onResultsChanged(): void;
  focus(): void;
  error(error: unknown): void;
}) {
  let query = '', options = { wholeWord: false, caseSensitive: false };
  let ready = false, dirty = false, disposed = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let total = 0, active: PreviewDocumentMatch | null = null;
  let anchor: SearchMatchAnchor | null = null;
  let counts: SearchResult['blocks'] = [];
  let steps = 0, navigationGeneration = 0;
  let ruler: HTMLCanvasElement | null = null;
  const events = new AbortController();
  const canRun = () => !disposed && ready && dependencies.isVisible();
  const cancelTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const publishVisibleAnchor = () => {
    const document = dependencies.getDocument();
    dependencies.visible.adapter.setSearchAnchor(active && document?.querySelector(`[data-meo-preview-block="${active.block}"]`)
      ? { line: active.line, occurrence: active.occurrence } : null);
  };
  const drawRuler = () => {
    const document = dependencies.getDocument(), window = document?.defaultView;
    if (!document || !window || !canRun() || !query || !total) { ruler?.remove(); ruler = null; return; }
    if (ruler?.ownerDocument !== document) {
      ruler?.remove(); ruler = document.createElement('canvas');
      ruler.className = 'meo-preview-search-overview-ruler'; ruler.setAttribute('aria-hidden', 'true');
      document.body.append(ruler);
    }
    const height = window.innerHeight, ratio = window.devicePixelRatio || 1;
    ruler.style.height = `${height}px`; ruler.width = Math.ceil(6 * ratio); ruler.height = Math.ceil(height * ratio);
    const context = ruler.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    const extent = Math.max(1, dependencies.viewport.totalHeight());
    context.fillStyle = '#ffff00';
    for (const [block] of counts) context.fillRect(0, Math.min(height - 2,
      dependencies.viewport.position(block) / extent * height), 6, 2);
    if (active) {
      context.fillStyle = '#ff9632';
      context.fillRect(0, Math.min(height - 3, dependencies.viewport.position(active.block) / extent * height), 6, 3);
    }
  };
  const run = async (selectIndex?: number, navigate = false): Promise<void> => {
    cancelTimer();
    if (!canRun()) return;
    const revision = ++generation, navigation = navigationGeneration;
    dirty = Boolean(query);
    if (!query) { total = 0; active = null; dirty = false; counts = []; drawRuler(); return; }
    try {
      const result = await dependencies.request(manifest.id, { kind: 'search', query, ...options,
        ...(selectIndex === undefined ? {} : { selectIndex }), ...(anchor === null ? {} : { anchor }) });
      if (disposed || revision !== generation || result.kind !== 'search') return;
      total = result.total; active = result.active; counts = result.blocks; dirty = false;
      if (active) anchor = { line: active.line, occurrence: active.occurrence };
      publishVisibleAnchor(); drawRuler(); dependencies.onResultsChanged();
      if (steps && total) {
        const next = ((active?.index ?? (steps > 0 ? -1 : 0)) + steps % total + total) % total;
        steps = 0;
        await run(next, true);
      } else if (navigate && active && navigation === navigationGeneration && canRun()) {
        const target = active;
        await dependencies.viewport.ensure({ block: target.block, align: 'center',
          isCurrent: () => !disposed && revision === generation && navigation === navigationGeneration && canRun() });
        if (disposed || revision !== generation || navigation !== navigationGeneration) return;
        dependencies.visible.revealAnchor({ line: target.line, occurrence: target.occurrence },
          () => !disposed && revision === generation && navigation === navigationGeneration && canRun());
      }
    } catch (error) {
      if (!disposed && revision === generation) { dirty = false; dependencies.error(error); dependencies.onResultsChanged(); }
    }
  };
  const schedule = () => {
    cancelTimer();
    if (canRun() && dirty) timer = setTimeout(() => { timer = null; void run(); }, 120);
  };
  const setSearchQuery = (text: string, nextOptions: SearchOptions = {}) => {
    const normalized = { wholeWord: nextOptions.wholeWord === true, caseSensitive: nextOptions.caseSensitive === true };
    dependencies.visible.adapter.setSearchQuery(text, normalized);
    if (query === text && options.wholeWord === normalized.wholeWord && options.caseSensitive === normalized.caseSensitive) return;
    generation += 1; navigationGeneration += 1; cancelTimer();
    query = text; options = normalized; total = 0; active = null; anchor = null; steps = 0; counts = [];
    dirty = Boolean(query); drawRuler(); schedule();
  };
  const find = (text: string, nextOptions: SearchOptions, direction: 1 | -1) => {
    setSearchQuery(text, nextOptions);
    dependencies.onNavigate();
    if (dirty) { steps += direction; if (timer !== null) void run(); }
    else if (total) { void run(((active?.index ?? (direction > 0 ? -1 : 0)) + direction + total) % total, true); }
    return { found: active !== null && !dirty, current: active ? active.index + 1 : 0, total };
  };
  const document = dependencies.getDocument();
  for (const type of ['wheel', 'pointerdown', 'touchstart']) document?.addEventListener(type,
    () => { navigationGeneration += 1; steps = 0; }, { capture: true, passive: true, signal: events.signal });
  dependencies.visible.setOverviewEnabled(false);
  return {
    adapter: {
      setSearchQuery,
      isSearchReady: canRun,
      isSearchPending: () => dirty,
      countMatches: () => total,
      getSearchAnchor: () => anchor,
      setSearchAnchor(next: SearchMatchAnchor | null) {
        if (anchor?.line === next?.line && anchor?.occurrence === next?.occurrence) return;
        anchor = next; active = null; generation += 1; dirty = Boolean(query); schedule();
      },
      findNext: (text: string, opts: SearchOptions) => find(text, opts, 1),
      findPrevious: (text: string, opts: SearchOptions) => find(text, opts, -1),
      focus: dependencies.focus
    },
    surfaceReady() { ready = true; dependencies.visible.surfaceReady(); schedule(); },
    surfaceHidden() { ready = false; cancelTimer(); dependencies.visible.surfaceHidden(); ruler?.remove(); ruler = null; },
    windowChanged() {
      dependencies.visible.invalidate();
      if (canRun()) dependencies.visible.surfaceReady();
      publishVisibleAnchor(); drawRuler();
    },
    refreshLayout: drawRuler,
    dispose() {
      disposed = true; generation += 1; navigationGeneration += 1; events.abort(); cancelTimer();
      ruler?.remove(); ruler = null; dependencies.visible.setOverviewEnabled(true);
    }
  };
}
