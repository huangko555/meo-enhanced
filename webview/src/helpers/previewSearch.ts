import type { SearchMatchAnchor } from '../application/searchMatchAnchor';

type SearchOptions = { wholeWord?: boolean; caseSensitive?: boolean };
type Match = { element: HTMLElement; anchor: SearchMatchAnchor };

export const previewSearchStyles = [
  '.meo-preview-search-match{background:#ffff00!important;color:#000000!important;-webkit-text-fill-color:#000000!important;outline:none}',
  '.meo-preview-search-match.is-active{background:#ff9632!important}',
  '.meo-preview-search-overview-ruler{position:fixed;top:0;right:3px;bottom:0;width:6px;pointer-events:none;z-index:6}',
  '.meo-preview-search-overview-ruler-marker{position:absolute;left:0;width:100%;height:2px;border-radius:1px;background:#ffff00}',
  '.meo-preview-search-overview-ruler-marker.is-active{height:3px;background:#ff9632}'
].join('\n');

export function createPreviewSearchController({
  getDocument, isVisible, onResultsChanged, onNavigate = () => {}, focus
}: {
  getDocument: () => Document | null;
  isVisible: () => boolean;
  onResultsChanged: () => void;
  onNavigate?: () => void;
  focus: () => void;
}) {
  let query = '';
  let options = { wholeWord: false, caseSensitive: false };
  let matches: Match[] = [];
  let retiredMatches: Match[] = [];
  const pendingNormalization = new Set<Node>();
  let activeIndex = -1;
  let activeElement: HTMLElement | null = null;
  let anchor: SearchMatchAnchor | null = null;
  let ready = false;
  let dirty = false;
  let disposed = false;
  let generation = 0;
  let searchTimer: number | null = null;
  let searchStep: (() => void) | null = null;
  let rulerFrame: number | null = null;
  let rulerTimer: number | null = null;
  let rulerGeneration = 0;
  let ruler: HTMLElement | null = null;
  let observedDocument: Document | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const canRun = () => !disposed && ready && isVisible() && Boolean(getDocument());
  const cancelSearch = () => {
    generation += 1;
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = null;
    searchStep = null;
  };
  const cancelRuler = () => {
    rulerGeneration += 1;
    if (rulerFrame !== null) window.cancelAnimationFrame(rulerFrame);
    if (rulerTimer !== null) window.clearTimeout(rulerTimer);
    rulerFrame = rulerTimer = null;
  };
  const clearMatches = () => {
    const parents = pendingNormalization;
    for (const { element } of [...retiredMatches, ...matches]) {
      if (!element.isConnected) continue;
      if (element.parentNode) parents.add(element.parentNode);
      element.replaceWith(element.ownerDocument.createTextNode(element.textContent ?? ''));
    }
    for (const parent of parents) parent.normalize();
    parents.clear();
    retiredMatches = [];
    matches = [];
    activeIndex = -1;
    activeElement = null;
    ruler?.replaceChildren();
  };

  const scheduleRuler = () => {
    cancelRuler();
    if (!canRun() || dirty || !query) return;
    const doc = getDocument()!;
    const revision = rulerGeneration;
    rulerFrame = window.requestAnimationFrame(() => {
      rulerFrame = null;
      const scroll = doc.scrollingElement;
      if (!canRun() || doc !== getDocument() || !scroll) return;
      if (ruler?.ownerDocument !== doc) {
        ruler?.remove();
        ruler = doc.createElement('div');
        ruler.className = 'meo-preview-search-overview-ruler';
        ruler.setAttribute('aria-hidden', 'true');
        doc.body.append(ruler);
      }
      const height = ruler.clientHeight;
      const scrollHeight = scroll.scrollHeight;
      const positions = new Map<number, boolean>();
      let index = 0;
      const measure = () => {
        rulerTimer = null;
        if (revision !== rulerGeneration || !canRun() || doc !== getDocument()) return;
        const deadline = performance.now() + 4;
        do {
          if (index >= matches.length) break;
          const match = matches[index]!;
          const top = Math.min(Math.max(0, height - 3), Math.max(0,
            Math.round((match.element.getBoundingClientRect().top + scroll.scrollTop) / scrollHeight * height)));
          positions.set(top, positions.get(top) === true || index === activeIndex);
          index += 1;
        } while (performance.now() < deadline);
        if (index < matches.length) {
          rulerTimer = window.setTimeout(measure, 0);
          return;
        }
        const fragment = doc.createDocumentFragment();
        for (const [top, active] of positions) {
          const marker = doc.createElement('span');
          marker.className = 'meo-preview-search-overview-ruler-marker' + (active ? ' is-active' : '');
          marker.style.top = String(top) + 'px';
          fragment.append(marker);
        }
        ruler!.replaceChildren(fragment);
      };
      measure();
    });
  };

  const observeGeometry = (doc: Document) => {
    if (observedDocument === doc) return;
    resizeObserver?.disconnect();
    observedDocument?.defaultView?.removeEventListener('resize', scheduleRuler);
    observedDocument = doc;
    const root = doc.querySelector('.meo-export-doc');
    const FrameResizeObserver = (doc.defaultView as unknown as Pick<typeof globalThis, 'ResizeObserver'>)?.ResizeObserver;
    if (FrameResizeObserver && root) {
      resizeObserver = new FrameResizeObserver(scheduleRuler);
      resizeObserver.observe(root);
    }
    doc.defaultView?.addEventListener('resize', scheduleRuler);
  };

  const applyAnchor = () => {
    activeIndex = anchor ? matches.findIndex(match =>
      match.anchor.line === anchor!.line && match.anchor.occurrence === anchor!.occurrence) : -1;
    // Source-only syntax can disappear in Preview. Keep navigation near that source line.
    if (anchor && activeIndex < 0 && matches.length) {
      activeIndex = matches.reduce((best, match, index) =>
        Math.abs(match.anchor.line - anchor!.line) < Math.abs(matches[best]!.anchor.line - anchor!.line)
          ? index : best, 0);
    }
    const element = matches[activeIndex]?.element ?? null;
    if (activeElement !== element) {
      activeElement?.classList.remove('is-active');
      element?.classList.add('is-active');
      activeElement = element;
    }
    scheduleRuler();
  };

  const startSearch = () => {
    searchTimer = null;
    if (!canRun() || !dirty) {
      scheduleRuler();
      return;
    }
    const oldMatches = [...retiredMatches, ...matches];
    retiredMatches = oldMatches;
    const parents = pendingNormalization;
    let clearIndex = 0;
    matches = [];
    activeIndex = -1;
    activeElement = null;
    ruler?.replaceChildren();
    const doc = getDocument()!;
    const root = doc.querySelector<HTMLElement>('.meo-export-doc');
    if (!root || !query) {
      dirty = false;
      onResultsChanged();
      return;
    }
    observeGeometry(doc);
    const revision = generation;
    const comparableQuery = options.caseSensitive ? query : query.toLocaleLowerCase();
    const nodes: Text[] = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement && !node.parentElement.closest('script, style, noscript, svg')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    let collecting = true;
    let nodeIndex = 0;
    const occurrences = new Map<number, number>();
    const lineOffsets = new Map<HTMLElement, number>();
    let pendingNode: {
      node: Text; raw: string; comparable: string; offset: number; cursor: number;
      line: number; fragment: DocumentFragment; changed: boolean;
    } | null = null;
    const publishNode = () => {
      if (!pendingNode?.changed) return;
      const tail = doc.createTextNode(pendingNode.raw.slice(pendingNode.cursor));
      pendingNode.fragment.append(tail);
      pendingNode.node.replaceWith(pendingNode.fragment);
      pendingNode.node = tail;
      pendingNode.fragment = doc.createDocumentFragment();
      pendingNode.changed = false;
    };
    searchStep = () => {
      searchTimer = null;
      if (revision !== generation || !canRun() || doc !== getDocument()) return;
      const deadline = performance.now() + 4;
      while (clearIndex < oldMatches.length && performance.now() < deadline) {
        const element = oldMatches[clearIndex++]!.element;
        if (!element.isConnected) continue;
        if (element.parentNode) parents.add(element.parentNode);
        element.replaceWith(element.ownerDocument.createTextNode(element.textContent ?? ''));
      }
      if (clearIndex < oldMatches.length) {
        searchTimer = window.setTimeout(searchStep!, 0);
        return;
      }
      retiredMatches = [];
      while (parents.size && performance.now() < deadline) {
        const parent = parents.values().next().value!;
        parents.delete(parent);
        parent.normalize();
      }
      if (parents.size) {
        searchTimer = window.setTimeout(searchStep!, 0);
        return;
      }
      while (collecting && performance.now() < deadline) {
        if (walker.nextNode()) nodes.push(walker.currentNode as Text);
        else collecting = false;
      }
      while (!collecting && (pendingNode || nodeIndex < nodes.length) && performance.now() < deadline) {
        if (!pendingNode) {
          const node = nodes[nodeIndex++]!;
          const raw = node.data;
          const mapped = node.parentElement?.closest<HTMLElement>('[data-source-line]');
          const prefixLines = mapped ? lineOffsets.get(mapped) ?? 0 : 0;
          if (mapped) lineOffsets.set(mapped, prefixLines + (raw.match(/\n/g)?.length ?? 0));
          pendingNode = {
            node, raw, comparable: options.caseSensitive ? raw : raw.toLocaleLowerCase(),
            offset: 0, cursor: 0, fragment: doc.createDocumentFragment(), changed: false,
            line: Number(mapped?.dataset.sourceLine ?? 1) + prefixLines
              + (mapped?.tagName === 'PRE' && !mapped.classList.contains('meo-export-frontmatter-source') ? 1 : 0)
          };
        }
        const node = pendingNode;
        const start = node.comparable.indexOf(comparableQuery, node.offset);
        if (start < 0) {
          publishNode();
          pendingNode = null;
          continue;
        }
        const end = start + comparableQuery.length;
        node.offset = Math.max(end, start + 1);
        if (options.wholeWord && (/[\p{L}\p{N}_]/u.test(node.raw[start - 1] ?? '')
          || /[\p{L}\p{N}_]/u.test(node.raw[end] ?? ''))) continue;
        const before = node.raw.slice(node.cursor, start);
        node.line += before.match(/\n/g)?.length ?? 0;
        node.fragment.append(doc.createTextNode(before));
        const element = doc.createElement('mark');
        element.className = 'meo-preview-search-match';
        element.textContent = node.raw.slice(start, end);
        const occurrence = occurrences.get(node.line) ?? 0;
        occurrences.set(node.line, occurrence + 1);
        matches.push({ element, anchor: { line: node.line, occurrence } });
        node.fragment.append(element);
        node.line += element.textContent.match(/\n/g)?.length ?? 0;
        node.cursor = end;
        node.changed = true;
      }
      // Publish bounded batches even when a code block is one enormous text node.
      publishNode();
      if (collecting || pendingNode || nodeIndex < nodes.length) {
        searchTimer = window.setTimeout(searchStep!, 0);
        return;
      }
      searchStep = null;
      dirty = false;
      applyAnchor();
      onResultsChanged();
    };
    searchStep();
  };

  const scheduleSearch = () => {
    if (!canRun() || searchTimer !== null || searchStep) return;
    if (dirty) searchTimer = window.setTimeout(startSearch, 0);
    else scheduleRuler();
  };

  const setSearchQuery = (nextQuery: string, nextOptions: SearchOptions = {}) => {
    const normalized = { wholeWord: nextOptions.wholeWord === true, caseSensitive: nextOptions.caseSensitive === true };
    if (query === nextQuery && options.wholeWord === normalized.wholeWord && options.caseSensitive === normalized.caseSensitive) return;
    cancelSearch();
    cancelRuler();
    query = nextQuery;
    options = normalized;
    anchor = null;
    dirty = Boolean(query);
    if (!query) clearMatches();
    else scheduleSearch();
  };

  const find = (nextQuery: string, nextOptions: SearchOptions, direction: 1 | -1) => {
    setSearchQuery(nextQuery, nextOptions);
    // An explicit navigation may finish pending matching; mode switches never do.
    if (canRun() && dirty) {
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      if (!searchStep) startSearch();
      while (searchStep && canRun()) {
        if (searchTimer !== null) window.clearTimeout(searchTimer);
        searchStep();
      }
    }
    if (!matches.length || dirty) return { found: false, current: 0, total: 0 };
    activeIndex = activeIndex < 0 ? (direction === 1 ? 0 : matches.length - 1)
      : (activeIndex + direction + matches.length) % matches.length;
    anchor = matches[activeIndex]!.anchor;
    applyAnchor();
    onNavigate();
    matches[activeIndex]!.element.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, current: activeIndex + 1, total: matches.length };
  };

  return {
    adapter: {
      setSearchQuery,
      isSearchReady: canRun,
      isSearchPending: () => dirty,
      countMatches: () => matches.length,
      getSearchAnchor: () => anchor,
      setSearchAnchor: (nextAnchor: SearchMatchAnchor | null) => {
        if (anchor?.line === nextAnchor?.line && anchor?.occurrence === nextAnchor?.occurrence) return;
        anchor = nextAnchor;
        if (!dirty) applyAnchor();
      },
      findNext: (text: string, opts: SearchOptions) => find(text, opts, 1),
      findPrevious: (text: string, opts: SearchOptions) => find(text, opts, -1),
      focus
    },
    surfaceReady: () => { ready = true; scheduleSearch(); },
    surfaceHidden: () => { ready = false; cancelSearch(); cancelRuler(); },
    invalidate: () => { ready = false; dirty = Boolean(query); cancelSearch(); cancelRuler(); },
    refreshLayout: scheduleRuler,
    dispose: () => {
      disposed = true;
      cancelSearch();
      cancelRuler();
      clearMatches();
      resizeObserver?.disconnect();
      observedDocument?.defaultView?.removeEventListener('resize', scheduleRuler);
      ruler?.remove();
    }
  };
}
