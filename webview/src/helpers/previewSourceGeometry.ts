export type PreviewSourceEntry = {
  element: HTMLElement;
  start: number;
  end: number;
  top: number;
  bottom: number;
  rendered: boolean;
};

type SourceNode = { element: HTMLElement; entry?: PreviewSourceEntry; children: SourceNode[] };

/** A visual lookup takes the last entry starting before its reading point.
 * At a shared start, put containers first so the inner source wins the tie. */
export function comparePreviewVisualSourceEntries(
  left: Pick<PreviewSourceEntry, 'top' | 'bottom' | 'start' | 'end'>,
  right: Pick<PreviewSourceEntry, 'top' | 'bottom' | 'start' | 'end'>
): number {
  return left.top - right.top || right.bottom - left.bottom || left.start - right.start || right.end - left.end;
}

/** Source identity is indexed once. Geometry belongs to the current reading
 * band: resource reflow must not turn a caret/scroll query into a document walk.
 * Complete DOM remains available to native selection, find, links and copying. */
export function createPreviewSourceGeometry(document: Document) {
  const main = document.querySelector<HTMLElement>('main.meo-export-doc');
  if (!main) return null;
  const nodes = new WeakMap<HTMLElement, SourceNode>();
  const roots = Array.from(main.children, element => {
    const node: SourceNode = { element: element as HTMLElement, children: [] };
    nodes.set(node.element, node);
    return node;
  });
  const entries: PreviewSourceEntry[] = [];
  for (const element of Array.from(main.querySelectorAll<HTMLElement>('[data-source-line],details'))) {
    const start = Number.parseInt(element.dataset.sourceLine ?? '', 10);
    if (!Number.isFinite(start) && element.tagName !== 'DETAILS') continue;
    const parsedEnd = Number.parseInt(element.dataset.sourceEndLine ?? '', 10);
    const entry: PreviewSourceEntry | undefined = Number.isFinite(start)
      ? { element, start, end: Number.isFinite(parsedEnd) ? Math.max(start, parsedEnd) : start,
        top: 0, bottom: 0, rendered: false } : undefined;
    if (entry) entries.push(entry);
    const existing = nodes.get(element);
    if (existing) { existing.entry = entry; continue; }
    const node: SourceNode = { element, entry, children: [] };
    nodes.set(element, node);
    let parent = element.parentElement;
    while (parent && parent !== main && !nodes.has(parent)) parent = parent.parentElement;
    if (parent && parent !== main) nodes.get(parent)!.children.push(node);
  }
  const includeDescendantRanges = (node: SourceNode): { start: number; end: number } => {
    let start = node.entry?.start ?? Infinity, end = node.entry?.end ?? 0;
    for (const child of node.children) {
      const range = includeDescendantRanges(child);
      start = Math.min(start, range.start); end = Math.max(end, range.end);
    }
    // A Markdown-in-HTML disclosure's opening token only labels its summary.
    // The collapsed reading box represents its entire source body as well.
    if (node.element.tagName === 'DETAILS' && Number.isFinite(start)) {
      if (node.entry) node.entry.end = end;
      else {
        // Several raw opening tags can share one token. An unlabelled nested
        // disclosure still owns the indexed Markdown descendants it suppresses.
        node.entry = { element: node.element, start, end, top: 0, bottom: 0, rendered: false };
        entries.push(node.entry);
      }
    }
    return { start, end };
  };
  for (const root of roots) includeDescendantRanges(root);
  entries.sort((left, right) => left.start - right.start || right.end - left.end);
  const collapsedOwner = (entry: PreviewSourceEntry): PreviewSourceEntry | undefined => {
    let owner: PreviewSourceEntry | undefined;
    for (let parent = entry.element.parentElement; parent && parent !== main; parent = parent.parentElement) {
      if (parent.tagName !== 'DETAILS' || parent.hasAttribute('open')) continue;
      const summary = Array.from(parent.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(entry.element)) owner = nodes.get(parent)?.entry ?? owner;
    }
    return owner;
  };
  const measure = (entry: PreviewSourceEntry): PreviewSourceEntry => {
    // Chromium can return nonzero layout rectangles for suppressed bodies.
    // Do not force that hidden layout merely to reject it as a reading box.
    if (collapsedOwner(entry)) return { ...entry, rendered: false };
    const scrollTop = document.scrollingElement?.scrollTop ?? 0;
    const rect = entry.element.getBoundingClientRect();
    return { ...entry, top: rect.top + scrollTop, bottom: rect.bottom + scrollTop,
      rendered: entry.element.getClientRects().length > 0 };
  };
  const project = (entry: PreviewSourceEntry): PreviewSourceEntry => measure(collapsedOwner(entry) ?? entry);
  const viewport = (offset: number, height: number): PreviewSourceEntry[] => {
    const scrollTop = document.scrollingElement?.scrollTop ?? 0;
    const minimum = offset - scrollTop, maximum = minimum + height;
    const rectangles = new Map<SourceNode, DOMRect>();
    const rect = (node: SourceNode) => {
      let value = rectangles.get(node);
      if (!value) { value = node.element.getBoundingClientRect(); rectangles.set(node, value); }
      return value;
    };
    // Reading roots follow normal document flow. An unpainted root has no
    // sortable rectangle; fall back to root-only discovery in that rare case.
    let low = 0, high = roots.length - 1, sortable = true;
    while (low <= high) {
      const middle = (low + high) >>> 1, bounds = rect(roots[middle]);
      if (bounds.height === 0 && bounds.top === 0) { sortable = false; break; }
      if (bounds.bottom < minimum) low = middle + 1;
      else high = middle - 1;
    }
    const result: PreviewSourceEntry[] = [];
    const visit = (node: SourceNode) => {
      const bounds = rect(node);
      if (node.entry && node.element.getClientRects().length > 0) result.push({ ...node.entry,
        top: bounds.top + scrollTop, bottom: bounds.bottom + scrollTop, rendered: true });
      if (node.element.tagName === 'DETAILS' && !node.element.hasAttribute('open')) {
        const summary = Array.from(node.element.children).find(child => child.tagName === 'SUMMARY');
        for (const child of node.children) if (summary?.contains(child.element)) visit(child);
        return;
      }
      if (bounds.bottom < minimum || bounds.top > maximum) {
        const edge = bounds.bottom < minimum ? node.children.at(-1) : node.children[0];
        if (edge) visit(edge);
        return;
      }
      // Footnotes form one very tall source container. Descending every note
      // would force skipped subtrees to lay out just to locate the few visible
      // notes. Their generated list follows normal flow, like reading roots.
      if (node.element.matches('section.footnotes')) {
        let first = 0, last = node.children.length - 1;
        while (first <= last) {
          const middle = (first + last) >>> 1;
          if (rect(node.children[middle]).bottom < minimum) first = middle + 1;
          else last = middle - 1;
        }
        for (let index = Math.max(0, first - 1); index < node.children.length; index++) {
          const child = node.children[index];
          visit(child);
          if (rect(child).top > maximum) break;
        }
      } else for (const child of node.children) visit(child);
    };
    let passedBand = false;
    let before: SourceNode | undefined, after: SourceNode | undefined;
    for (let index = sortable ? Math.max(0, low - 1) : 0; index < roots.length; index++) {
      const node = roots[index];
      const bounds = rect(node);
      if (!sortable && (bounds.bottom < minimum || bounds.top > maximum)) {
        if (bounds.height > 0) {
          if (bounds.bottom < minimum && (!before || rect(before).bottom < bounds.bottom)) before = node;
          if (bounds.top > maximum && (!after || rect(after).top > bounds.top)) after = node;
        }
        continue;
      }
      visit(node);
      if (sortable && bounds.top > maximum) {
        // Keep the next source block for whitespace interpolation.
        if (passedBand) break;
        passedBand = true;
      }
    }
    if (!sortable) { if (before) visit(before); if (after) visit(after); }
    return result.sort(comparePreviewVisualSourceEntries);
  };
  const linkedRegions = () => roots.flatMap(root => {
    const members: PreviewSourceEntry[] = [];
    const collect = (node: SourceNode) => { if (node.entry) members.push(node.entry); for (const child of node.children) collect(child); };
    collect(root);
    if (!members.length || root.element.getClientRects().length === 0) return [];
    const bounds = root.element.getBoundingClientRect(), top = document.scrollingElement?.scrollTop ?? 0;
    return [{ startLine: Math.min(...members.map(entry => entry.start)), endLine: Math.max(...members.map(entry => entry.end)),
      top: bounds.top + top, bottom: bounds.bottom + top }];
  });
  return { entries, measure, project, viewport, linkedRegions };
}
