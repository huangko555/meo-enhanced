import type { MermaidConfig } from 'mermaid';

const adaptiveLabels = 'data-meo-adaptive-labels';
const htmlNamespace = 'http://www.w3.org/1999/xhtml';

/** Use Mermaid's parsed author configuration before it draws the diagram. */
export function enableAdaptiveMermaidLabels(svg: SVGElement, config: MermaidConfig, authored: MermaidConfig, defaultLabelCss: string): void {
  if (config.themeCSS === defaultLabelCss && config.markdownAutoWrap !== false
    && authored.flowchart?.wrappingWidth === undefined) svg.setAttribute(adaptiveLabels, '');
}

/** Reuse Mermaid's first measurement to size the longest natural word. */
export function prepareMermaidLabelMeasurement(box: HTMLElement, width: number, minWidth: number): ((minimum: number) => void) | undefined {
  if (!Number.isFinite(width) || width <= 0 || !box.closest('svg')?.hasAttribute(adaptiveLabels)) return;
  const paragraph = box.querySelector<HTMLElement>(':scope > :is(.nodeLabel, .edgeLabel) > p');
  if (!paragraph || paragraph.nextElementSibling) return;

  const cap = width * 2;
  const identifiers = keepIdentifierWords(paragraph);
  paragraph.style.setProperty('overflow-wrap', 'break-word', 'important');
  box.style.setProperty('width', 'min-content', 'important');
  box.style.maxWidth = `${cap}px`;

  return minimum => {
    if (minimum >= cap - 0.5) {
      const oversized = identifiers.filter(word => word.getBoundingClientRect().width > cap);
      for (const word of oversized) allowIdentifierBreaks(word, paragraph);
    }
    box.style.removeProperty('width');
    box.style.maxWidth = `${Math.min(cap, Math.max(width, Math.ceil(minimum)))}px`;
    if (minWidth > 0) box.style.minWidth = `${minWidth}px`;
  };
}

function keepIdentifierWords(paragraph: HTMLElement): HTMLElement[] {
  if (!/[_-]/u.test(paragraph.textContent ?? '')) return [];
  const document = paragraph.ownerDocument;
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  const identifiers: HTMLElement[] = [];
  for (const text of textNodes) {
    if (text.parentElement?.namespaceURI !== htmlNamespace || text.parentElement.closest('.katex')) continue;
    const matches = [...text.data.matchAll(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)+/gu)];
    if (!matches.length) continue;
    const parts = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      const word = document.createElementNS(htmlNamespace, 'span') as HTMLElement;
      word.style.whiteSpace = 'nowrap';
      word.textContent = match[0];
      parts.append(text.data.slice(offset, match.index), word);
      identifiers.push(word);
      offset = match.index + match[0].length;
    }
    parts.append(text.data.slice(offset));
    text.replaceWith(parts);
  }
  return identifiers;
}

function allowIdentifierBreaks(word: HTMLElement, paragraph: HTMLElement): void {
  const segments = word.textContent!.split(/(?<=[_-])/u);
  const document = paragraph.ownerDocument;
  const contents = document.createDocumentFragment();
  for (const [index, segment] of segments.entries()) {
    if (index > 0) contents.append(document.createElementNS(htmlNamespace, 'wbr'));
    contents.append(segment);
  }
  word.replaceWith(contents);
}
