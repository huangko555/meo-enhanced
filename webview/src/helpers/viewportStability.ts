type ViewportOwner = { dom: HTMLElement };

const lastInteractionAt = new WeakMap<HTMLElement, number>();
const anchorGeneration = new WeakMap<HTMLElement, number>();

const now = (): number => typeof performance === 'undefined' ? Date.now() : performance.now();

export function markViewportInteraction(view: ViewportOwner): void {
  lastInteractionAt.set(view.dom, now());
  anchorGeneration.set(view.dom, (anchorGeneration.get(view.dom) ?? 0) + 1);
}

export function hasRecentViewportInteraction(view: ViewportOwner, quietPeriodMs = 180): boolean {
  const lastInteraction = lastInteractionAt.get(view.dom);
  return lastInteraction !== undefined && now() - lastInteraction < quietPeriodMs;
}

export function beginViewportAnchor(view: ViewportOwner): number {
  const generation = (anchorGeneration.get(view.dom) ?? 0) + 1;
  anchorGeneration.set(view.dom, generation);
  return generation;
}

export function canApplyViewportAnchor(view: ViewportOwner, generation: number): boolean {
  return anchorGeneration.get(view.dom) === generation && !hasRecentViewportInteraction(view);
}
