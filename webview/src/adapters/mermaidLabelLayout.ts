import type { MermaidConfig } from 'mermaid';

const labelLayout = 'data-meo-label-layout';
const htmlNamespace = 'http://www.w3.org/1999/xhtml';

/** Use Mermaid's parsed author configuration before it draws the diagram. */
export function configureMermaidLabelLayout(svg: SVGElement, config: MermaidConfig, authored: MermaidConfig, defaultLabelCss: string): void {
  if (config.themeCSS !== defaultLabelCss || config.markdownAutoWrap === false) return;
  svg.setAttribute(labelLayout, authored.flowchart?.wrappingWidth === undefined ? 'adaptive' : 'fixed-nodes');
}

/** Reuse Mermaid's first measurement to size the longest natural word. */
export function prepareMermaidLabelMeasurement(box: HTMLElement, width: number, minWidth: number): ((minimum: number) => void) | undefined {
  if (!Number.isFinite(width) || width <= 0) return;
  const layout = box.closest('svg')?.getAttribute(labelLayout);
  if (!layout) return;
  const label = box.querySelector(':scope > :is(.nodeLabel, .edgeLabel)');
  if (!label) return;
  const paragraphs = label.querySelectorAll<HTMLElement>(':scope > p');
  if (!paragraphs.length) return;

  const fixedWidth = layout === 'fixed-nodes' && label.classList.contains('nodeLabel');
  const cap = fixedWidth ? width : width * 2;
  const identifiers: HTMLElement[] = [];
  for (const paragraph of paragraphs) {
    identifiers.push(...keepIdentifierWords(paragraph));
    paragraph.style.setProperty('overflow-wrap', 'break-word', 'important');
  }
  box.style.setProperty('width', 'min-content', 'important');
  box.style.maxWidth = `${cap}px`;

  return minimum => {
    if (minimum >= cap - 0.5) {
      const oversized = identifiers.filter(word => word.getBoundingClientRect().width > cap);
      for (const word of oversized) allowIdentifierBreaks(word);
    }
    box.style.removeProperty('width');
    box.style.maxWidth = `${Math.min(cap, Math.max(width, Math.ceil(minimum)))}px`;
    if (!fixedWidth && minWidth > 0) box.style.minWidth = `${minWidth}px`;
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

function allowIdentifierBreaks(word: HTMLElement): void {
  const segments = word.textContent!.split(/(?<=[_-])/u);
  const document = word.ownerDocument;
  const contents = document.createDocumentFragment();
  for (const [index, segment] of segments.entries()) {
    if (index > 0) contents.append(document.createElementNS(htmlNamespace, 'wbr'));
    contents.append(segment);
  }
  word.replaceWith(contents);
}
