type ResourceKind = 'code' | 'mermaid' | 'copy';
type Candidates = Record<ResourceKind, Set<HTMLElement>> & { mermaidOrder: WeakMap<HTMLElement, number> };
const candidatesByDocument = new WeakMap<Document, Candidates>();

/** Undefined preserves the standalone/small-document renderer's existing path. */
export function getPreviewViewportResources(document: Document, kind: ResourceKind): readonly HTMLElement[] | undefined {
  const candidates = candidatesByDocument.get(document);
  return candidates ? [...candidates[kind]] : undefined;
}

/** Resource identity follows document order, independently of viewport membership. */
export function getPreviewMermaidResourceIndex(document: Document, element: HTMLElement): number | undefined {
  return candidatesByDocument.get(document)?.mermaidOrder.get(element);
}

/** Owns the resource index for one presentation, including preserved iframe updates. */
export function observePreviewViewportResources(document: Document, changed: () => void) {
  const Observer = (document.defaultView as (Window & typeof globalThis) | null)?.IntersectionObserver;
  if (document.documentElement.dataset.meoPreviewLargeDocument !== 'true' || !Observer) return null;
  const candidates: Candidates = { code: new Set(), mermaid: new Set(), copy: new Set(), mermaidOrder: new WeakMap() };
  let resources: HTMLElement[] = [];
  const kinds = new Map<HTMLElement, ResourceKind[]>();
  let active = false;
  let disposed = false;
  const observer = new Observer(entries => {
    if (!active || disposed) return;
    let updated = false;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      for (const kind of kinds.get(element) ?? []) {
        const set = candidates[kind];
        if (entry.isIntersecting && element.isConnected) {
          if (!set.has(element)) { set.add(element); updated = true; }
        } else if (set.delete(element)) updated = true;
      }
    }
    if (updated) changed();
  }, { rootMargin: '100% 0px' });
  const refresh = () => {
    if (disposed) return;
    observer.disconnect(); kinds.clear();
    candidates.code.clear(); candidates.mermaid.clear(); candidates.copy.clear();
    resources = Array.from(document.querySelectorAll<HTMLElement>(
      'code.hljs,.meo-export-code-block-wrap,.meo-export-mermaid[data-source-b64],.meo-export-math-display'
    ));
    let mermaidIndex = 0;
    const blockIndices = new Map<number, number>();
    for (const element of resources) {
      const values: ResourceKind[] = [];
      if (element.matches('code.hljs')) values.push('code');
      if (element.matches('.meo-export-mermaid[data-source-b64]')) {
        values.push('mermaid');
        const owner = element.closest<HTMLElement>('[data-meo-preview-block]');
        const block = owner ? Number(owner.dataset.meoPreviewBlock) : NaN;
        if (Number.isSafeInteger(block) && block >= 0) {
          const local = blockIndices.get(block) ?? 0;
          blockIndices.set(block, local + 1);
          candidates.mermaidOrder.set(element, (block + local) * (block + local + 1) / 2 + local);
        } else candidates.mermaidOrder.set(element, mermaidIndex++);
      }
      if (element.matches('.meo-export-code-block-wrap,.meo-export-mermaid,.meo-export-math-display')) values.push('copy');
      kinds.set(element, values);
      if (active) observer.observe(element);
    }
  };
  candidatesByDocument.set(document, candidates);
  refresh();
  return {
    refresh,
    setActive(next: boolean) {
      if (disposed || active === next) return;
      active = next;
      observer.disconnect();
      candidates.code.clear(); candidates.mermaid.clear(); candidates.copy.clear();
      if (active) for (const resource of resources) if (resource.isConnected) observer.observe(resource);
    },
    dispose() {
      disposed = true; active = false;
      observer.disconnect();
      candidates.code.clear(); candidates.mermaid.clear(); candidates.copy.clear();
      kinds.clear(); resources.length = 0;
      if (candidatesByDocument.get(document) === candidates) candidatesByDocument.delete(document);
    }
  };
}
