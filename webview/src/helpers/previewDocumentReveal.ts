/** Reveal inside the Preview document without scrolling the embedding Webview. */
export function revealPreviewDocumentElement(element: HTMLElement, block: ScrollLogicalPosition): void {
  const document = element.ownerDocument;
  const window = document.defaultView;
  const root = document.scrollingElement;
  if (!window || !root || !element.isConnected) return;
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const style = window.getComputedStyle(element);
  const margin = { top: pixels(style.scrollMarginTop), bottom: pixels(style.scrollMarginBottom),
    left: pixels(style.scrollMarginLeft), right: pixels(style.scrollMarginRight) };
  const delta = (start: number, end: number, low: number, high: number, align: ScrollLogicalPosition): number => {
    if (align === 'start') return start - low;
    if (align === 'end') return end - high;
    if (align === 'center') return (start + end - low - high) / 2;
    if ((start >= low && end <= high) || (start < low && end > high)) return 0;
    return (start < low && end - start <= high - low) || (end > high && end - start > high - low)
      ? start - low : end - high;
  };
  // Code, tables and authored HTML can own an inner scroll range. Reveal those
  // first, then the document; never let native scrollIntoView cross the iframe.
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent === root) continue;
    const parentStyle = window.getComputedStyle(parent);
    const vertical = parent.scrollHeight > parent.clientHeight && /^(auto|scroll|hidden)$/.test(parentStyle.overflowY);
    const horizontal = parent.scrollWidth > parent.clientWidth && /^(auto|scroll|hidden)$/.test(parentStyle.overflowX);
    if (!vertical && !horizontal) continue;
    const bounds = element.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    const top = box.top + parent.clientTop, left = box.left + parent.clientLeft;
    parent.scrollBy({
      top: vertical ? delta(bounds.top - margin.top, bounds.bottom + margin.bottom,
        top + pixels(parentStyle.scrollPaddingTop), top + parent.clientHeight - pixels(parentStyle.scrollPaddingBottom), block) : 0,
      left: horizontal ? delta(bounds.left - margin.left, bounds.right + margin.right,
        left + pixels(parentStyle.scrollPaddingLeft), left + parent.clientWidth - pixels(parentStyle.scrollPaddingRight), 'nearest') : 0,
      behavior: 'instant'
    });
  }
  const bounds = element.getBoundingClientRect();
  const rootStyle = window.getComputedStyle(root);
  window.scrollBy({
    top: delta(bounds.top - margin.top, bounds.bottom + margin.bottom,
      pixels(rootStyle.scrollPaddingTop), document.documentElement.clientHeight - pixels(rootStyle.scrollPaddingBottom), block),
    left: delta(bounds.left - margin.left, bounds.right + margin.right,
      pixels(rootStyle.scrollPaddingLeft), document.documentElement.clientWidth - pixels(rootStyle.scrollPaddingRight), 'nearest'),
    behavior: 'instant'
  });
}
