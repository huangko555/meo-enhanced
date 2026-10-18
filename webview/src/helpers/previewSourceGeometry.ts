export type PreviewSourceEntry = {
  element: HTMLElement;
  start: number;
  end: number;
  top: number;
  bottom: number;
  rendered: boolean;
};

type SourceNode = { element: HTMLElement; entry?: PreviewSourceEntry; children: SourceNode[] };

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
  for (const element of Array.from(main.querySelectorAll<HTMLElement>('[data-source-line]'))) {
    const start = Number.parseInt(element.dataset.sourceLine ?? '', 10);
    if (!Number.isFinite(start)) continue;
    const parsedEnd = Number.parseInt(element.dataset.sourceEndLine ?? '', 10);
    const entry: PreviewSourceEntry = { element, start, end: Number.isFinite(parsedEnd) ? Math.max(start, parsedEnd) : start,
      top: 0, bottom: 0, rendered: false };
    entries.push(entry);
    const existing = nodes.get(element);
    if (existing) { existing.entry = entry; continue; }
    const node: SourceNode = { element, entry, children: [] };
    nodes.set(element, node);
    let parent = element.parentElement;
    while (parent && parent !== main && !nodes.has(parent)) parent = parent.parentElement;
    if (parent && parent !== main) nodes.get(parent)!.children.push(node);
  }
  entries.sort((left, right) => left.start - right.start || right.end - left.end);
  const measure = (entry: PreviewSourceEntry): PreviewSourceEntry => {
    const scrollTop = document.scrollingElement?.scrollTop ?? 0;
    const rect = entry.element.getBoundingClientRect();
    return { ...entry, top: rect.top + scrollTop, bottom: rect.bottom + scrollTop,
      rendered: entry.element.getClientRects().length > 0 };
  };
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
      if (bounds.bottom < minimum || bounds.top > maximum) {
        const edge = bounds.bottom < minimum ? node.children.at(-1) : node.children[0];
        if (edge) visit(edge);
        return;
      }
      for (const child of node.children) visit(child);
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
    return result.sort((left, right) => left.top - right.top || left.bottom - right.bottom || left.start - right.start);
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
  const containOffscreenLayout = () => {
    // Keep the initially laid-out block heights, so enabling containment does
    // not replace the native scrollbar with a collection of tiny estimates.
    // Read first, write second; interleaving these causes quadratic layout.
    const heights = roots.map(root => root.element.getBoundingClientRect().height);
    for (let index = 0; index < roots.length; index++) {
      const element = roots[index].element;
      if (heights[index] <= 0) continue;
      element.style.containIntrinsicBlockSize = `auto ${heights[index]}px`;
      element.style.contentVisibility = 'auto';
    }
  };
  return { entries, measure, viewport, linkedRegions, containOffscreenLayout };
}
