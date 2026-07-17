export interface InlineSourceRange {
  from: number;
  to: number;
}

const sourceFromAttribute = 'data-meo-source-from';
const sourceToAttribute = 'data-meo-source-to';
const mappedSourceSelector = `[${sourceFromAttribute}][${sourceToAttribute}]`;

export function setInlineSourceRange(
  element: HTMLElement,
  range: InlineSourceRange,
  options: { atomic?: boolean } = {}
): void {
  element.setAttribute(sourceFromAttribute, String(range.from));
  element.setAttribute(sourceToAttribute, String(range.to));
  if (options.atomic) element.dataset.meoSourceAtom = 'true';
}

export function appendInlineMappedText(
  parent: HTMLElement,
  text: string,
  range: InlineSourceRange,
  className = ''
): HTMLElement {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  setInlineSourceRange(span, range);
  parent.appendChild(span);
  return span;
}

function readInlineSourceRange(element: Element | null): InlineSourceRange | null {
  if (!(element instanceof HTMLElement)) return null;
  const from = Number.parseInt(element.getAttribute(sourceFromAttribute) ?? '', 10);
  const to = Number.parseInt(element.getAttribute(sourceToAttribute) ?? '', 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return { from, to };
}

function mappedElementForNode(root: HTMLElement, node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const mapped = element?.closest(mappedSourceSelector);
  return mapped instanceof HTMLElement && root.contains(mapped) ? mapped : null;
}

function caretPointAt(clientX: number, clientY: number): { node: Node; offset: number } | null {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function sourceOffsetInsideMappedElement(
  element: HTMLElement,
  caretNode: Node,
  caretOffset: number,
  sourceRange: InlineSourceRange
): number {
  const visibleLength = element.textContent?.length ?? 0;
  if (visibleLength <= 0 || sourceRange.to === sourceRange.from) return sourceRange.from;

  const range = document.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(caretNode, caretOffset);
  } catch {
    return sourceRange.from;
  }
  const visibleOffset = Math.max(0, Math.min(range.toString().length, visibleLength));
  const ratio = visibleOffset / visibleLength;
  return Math.round(sourceRange.from + ratio * (sourceRange.to - sourceRange.from));
}

function distanceToRect(clientX: number, clientY: number, rect: DOMRect): number {
  const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
  const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
  return (dx * dx) + (dy * dy);
}

function nearestMappedOffset(root: HTMLElement, clientX: number, clientY: number): number | null {
  let best: { element: HTMLElement; rect: DOMRect; distance: number } | null = null;
  for (const element of root.querySelectorAll<HTMLElement>(mappedSourceSelector)) {
    for (const rect of Array.from(element.getClientRects())) {
      const distance = distanceToRect(clientX, clientY, rect);
      if (!best || distance < best.distance) best = { element, rect, distance };
    }
  }
  if (!best) return null;
  const sourceRange = readInlineSourceRange(best.element);
  if (!sourceRange) return null;
  return clientX <= best.rect.left + best.rect.width / 2 ? sourceRange.from : sourceRange.to;
}

export function resolveInlineSourceOffsetAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  options: { nearestFallback?: boolean } = {}
): number | null {
  const caret = caretPointAt(clientX, clientY);
  const mapped = mappedElementForNode(root, caret?.node ?? null);
  const sourceRange = readInlineSourceRange(mapped);
  if (caret && mapped && sourceRange) {
    if (mapped.dataset.meoSourceAtom === 'true') {
      const rect = mapped.getBoundingClientRect();
      return clientX <= rect.left + rect.width / 2 ? sourceRange.from : sourceRange.to;
    }
    return sourceOffsetInsideMappedElement(mapped, caret.node, caret.offset, sourceRange);
  }
  return options.nearestFallback === false ? null : nearestMappedOffset(root, clientX, clientY);
}
