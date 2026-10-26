import type { PreviewSourceLineMapper } from './previewSourceIdentity';

/** The frame owns its otherwise unpadded document root. Keep the fractional
 * remainder there when a full-DOM preview has no virtual gap to absorb it.
 * This changes neither the reading root's formatting nor its containing block. */
export function restoreFullPreviewReadingScrollTop(document: Document, top: number): boolean {
  const scroll = document.scrollingElement, window = document.defaultView;
  if (!scroll || !window) return false;
  scroll.scrollTop = top;
  const error = scroll.scrollTop - top;
  if (!Number.isFinite(error) || Math.abs(error) > 1 || Math.abs(error) < 0.001
    || top <= 1 || top >= scroll.scrollHeight - scroll.clientHeight - 1) return false;
  const root = document.documentElement, previous = parseFloat(root.style.paddingTop) || 0;
  const quantum = 1 / window.devicePixelRatio, total = previous + error;
  const whole = Math.floor(total / quantum) * quantum;
  root.style.paddingTop = `${total - whole}px`;
  if (whole) scroll.scrollTop -= whole;
  return true;
}

/** Retain an actual painted text position across a synchronous presentation
 * mutation. Estimated blocks and relocated footnotes cannot serve as witnesses. */
export function capturePreviewReadingAnchor(document: Document, restore: (top: number) => void, viewportRatio = 0,
  mapSourceLine?: PreviewSourceLineMapper): (() => boolean) | null {
  const window = document.defaultView, scroll = document.scrollingElement;
  const root = document.querySelector<HTMLElement>('main.meo-export-doc');
  if (!window || !scroll || !root) return null;
  // Presentation-only transactions sample a reading band. Font growth can add
  // scroll space below its painted character even when the old viewport ended
  // at the document boundary. Keep that text before falling back to an empty
  // estimated tail. Content edits retain their ratio-0 physical/source anchor.
  const atTop = scroll.scrollTop <= .5;
  const atEnd = scroll.scrollHeight > scroll.clientHeight
    && scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 1;
  if (viewportRatio > 0 && atTop) {
    return () => {
      if (!root.isConnected || root.ownerDocument !== document) return false;
      restore(0);
      return true;
    };
  }
  const bounds = root.getBoundingClientRect();
  const left = Math.max(4, bounds.left + 12);
  const readingY = window.innerHeight * viewportRatio;
  const bands = viewportRatio === 0 ? [4, 24, window.innerHeight / 3] : [readingY];
  for (const y of bands) {
    for (const x of [left, left + 36, bounds.left + bounds.width / 2]) {
      const range = document.caretRangeFromPoint(x, y);
      const node = range?.startContainer;
      if (!range || node?.nodeType !== 3 || !node.parentElement?.closest('main.meo-export-doc')
        || node.parentElement.closest('svg,script,style,.meo-preview-viewport-gap,.meo-preview-code-actions')) continue;
      const rect = range.getBoundingClientRect();
      if (!rect.height || rect.top < 0 || rect.bottom > window.innerHeight
        || rect.top > y + 24 || rect.bottom < y - 24) continue;
      let text = node as Text;
      const value = text.data, offset = range.startOffset;
      let retainedValue = value, retainedOffset = offset;
      let element = text.parentElement!.closest<HTMLElement>('[data-source-line]');
      const sourceLine = element?.dataset.sourceLine, sourceEndLine = element?.dataset.sourceEndLine;
      const mappedAttribute = (value: string | undefined) => {
        if (value === undefined || !mapSourceLine) return value;
        const mapped = mapSourceLine(Number(value));
        return mapped === undefined ? null : String(mapped);
      };
      const expectedLine = mappedAttribute(sourceLine), expectedEndLine = mappedAttribute(sourceEndLine);
      if (expectedLine === null || expectedEndLine === null) continue;
      let block = text.parentElement!.closest<HTMLElement>('p,li,td,th,pre,h1,h2,h3,h4,h5,h6,summary');
      const blockRect = block?.getBoundingClientRect();
      const rebindUnchangedText = (): boolean => {
        // Renderer/token markup can replace the Text node without changing the
        // authored block. Search only that exact mapped range, rejecting an
        // ambiguous witness; content edits retain their separate boundary rule.
        if (mapSourceLine || !element || expectedLine === undefined || !root.isConnected) return false;
        const matches = element.isConnected && element.dataset.sourceLine === expectedLine
          && element.dataset.sourceEndLine === expectedEndLine ? [element]
          : Array.from(root.querySelectorAll<HTMLElement>(`[data-source-line="${expectedLine}"]`))
            .filter(candidate => candidate.tagName === element!.tagName && candidate.dataset.sourceEndLine === expectedEndLine);
        if (matches.length !== 1) return false;
        const target = matches[0]!, content = target.textContent ?? '';
        const start = value ? content.indexOf(value) : -1;
        if (start < 0 || content.indexOf(value, start + 1) >= 0) return false;
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        let remaining = start + offset;
        let replacement: Text | null = null;
        while (walker.nextNode()) {
          const candidate = walker.currentNode as Text;
          if (remaining < candidate.length || remaining === candidate.length && offset > 0) {
            replacement = candidate;
            break;
          }
          remaining -= candidate.length;
        }
        if (!replacement) return false;
        text = replacement; element = target; retainedValue = text.data; retainedOffset = remaining;
        block = text.parentElement!.closest<HTMLElement>('p,li,td,th,pre,h1,h2,h3,h4,h5,h6,summary');
        return true;
      };
      const restoreEditedBoundary = (): boolean => {
        // A changed paragraph can replace its text witness while a window also
        // rebuilds estimated gaps above it. The same authored block boundary is
        // still a valid physical anchor; its new height/progress is not.
        if (!mapSourceLine || !block || block !== element || !blockRect || expectedLine === undefined
          || !root.isConnected) return false;
        const blockTag = block.tagName;
        const matches = Array.from(root.querySelectorAll<HTMLElement>(`[data-source-line="${expectedLine}"]`))
          .filter(candidate => candidate.tagName === blockTag);
        if (matches.length !== 1) return false;
        const target = matches[0]!;
        if (!target.getClientRects().length) return false;
        restore(scroll.scrollTop + target.getBoundingClientRect().top - blockRect.top);
        return true;
      };
      return () => {
        if (!text.isConnected || text.ownerDocument !== document || text.data !== retainedValue
          || element && (element.dataset.sourceLine !== expectedLine || element.dataset.sourceEndLine !== expectedEndLine)) {
          if (!rebindUnchangedText()) return restoreEditedBoundary();
        }
        // A DOM move adjusts live Range boundaries to the old parent even when
        // morphing retains the same text node. Recreate from immutable coordinates.
        const currentRange = document.createRange();
        currentRange.setStart(text, retainedOffset); currentRange.collapse(true);
        let previousDelta: number | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = currentRange.getBoundingClientRect();
          if (!current.height) return false;
          const bounds = block?.getBoundingClientRect();
          // Chromium can round a collapsed caret box while the containing line
          // still moves fractionally. An unchanged block has a precise layout
          // box; use its position and reserve the text point for actual reflow.
          const unchangedBox = bounds && blockRect && bounds.width === blockRect.width && bounds.height === blockRect.height;
          const delta = unchangedBox ? bounds.top - blockRect.top : current.top - rect.top;
          if (Math.abs(delta) < 0.001 || delta === previousDelta) break;
          previousDelta = delta;
          restore(scroll.scrollTop + delta);
        }
        return true;
      };
    }
  }
  if (viewportRatio > 0 && atEnd) {
    return () => {
      if (!root.isConnected || root.ownerDocument !== document) return false;
      restore(Math.max(0, scroll.scrollHeight - scroll.clientHeight));
      return true;
    };
  }
  // Blank space in a short code line or a graphic has no nearby text caret.
  // Its unchanged painted block is still an exact witness; semantic range
  // interpolation can otherwise move an idle viewport during work below it.
  if (!mapSourceLine) for (const y of bands) {
    for (const x of [left, left + 36, bounds.left + bounds.width / 2]) {
      const block = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-source-line]');
      if (!block || !root.contains(block) || block.closest('.meo-preview-viewport-gap')) continue;
      const rect = block.getBoundingClientRect();
      if (rect.top > y || rect.bottom < y || !rect.width || !rect.height) continue;
      return () => {
        if (!block.isConnected || block.ownerDocument !== document) return false;
        const current = block.getBoundingClientRect();
        if (current.width !== rect.width || current.height !== rect.height) return false;
        const delta = current.top - rect.top;
        if (Math.abs(delta) >= 0.001) restore(scroll.scrollTop + delta);
        return true;
      };
    }
  }
  if (!mapSourceLine && viewportRatio > 0) {
    // A paragraph margin has no caret or source element at the reading point.
    // Probe only the nearby painted boundaries; estimated gaps remain semantic.
    if ([...root.querySelectorAll<HTMLElement>('.meo-preview-viewport-gap')].some(gap => {
      const rect = gap.getBoundingClientRect(); return rect.top <= readingY && rect.bottom >= readingY;
    })) return null;
    let before: { node: HTMLElement; rect: DOMRect } | undefined;
    let after: { node: HTMLElement; rect: DOMRect } | undefined;
    for (const offset of [-24, 24, -48, 48, -72, 72]) for (const x of [left, left + 36, bounds.left + bounds.width / 2]) {
      const node = document.elementFromPoint(x, readingY + offset)?.closest<HTMLElement>('[data-source-line]');
      if (!node || !root.contains(node) || node.closest('.meo-preview-viewport-gap')) continue;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.bottom <= readingY && (!before || rect.bottom > before.rect.bottom)) before = { node, rect };
      if (rect.top >= readingY && (!after || rect.top < after.rect.top)) after = { node, rect };
    }
    if (before && after && after.rect.top > before.rect.bottom) {
      const progress = (readingY - before.rect.bottom) / (after.rect.top - before.rect.bottom);
      const snapshot = (node: HTMLElement) => ({ node, line: node.dataset.sourceLine,
        endLine: node.dataset.sourceEndLine, text: node.textContent });
      const previous = snapshot(before.node), next = snapshot(after.node);
      const valid = (edge: typeof previous) => edge.node.isConnected && edge.node.ownerDocument === document
        && root.contains(edge.node) && edge.node.dataset.sourceLine === edge.line
        && edge.node.dataset.sourceEndLine === edge.endLine && edge.node.textContent === edge.text;
      return () => {
        let previousDelta: number | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!valid(previous) || !valid(next)) return false;
          const from = previous.node.getBoundingClientRect(), to = next.node.getBoundingClientRect();
          if (!from.height || !to.height || to.top < from.bottom) return false;
          const delta = from.bottom + progress * (to.top - from.bottom) - readingY;
          if (Math.abs(delta) < .001 || delta === previousDelta) break;
          previousDelta = delta;
          restore(scroll.scrollTop + delta);
        }
        return true;
      };
    }
  }
  return null;
}
