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
  // Presentation-only transactions sample a reading band. At the actual end,
  // that intent is the document boundary, even when the visible tail is still
  // an estimated gap without a painted text witness. Content edits use ratio 0
  // and continue preserving their existing physical/semantic reading position.
  const atTop = scroll.scrollTop <= .5;
  if (viewportRatio > 0 && (atTop || scroll.scrollHeight > scroll.clientHeight
    && scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 1)) {
    return () => {
      if (!root.isConnected || root.ownerDocument !== document) return false;
      restore(atTop ? 0 : Math.max(0, scroll.scrollHeight - scroll.clientHeight));
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
      const text = node as Text, value = text.data, offset = range.startOffset;
      const element = text.parentElement!.closest<HTMLElement>('[data-source-line]');
      const sourceLine = element?.dataset.sourceLine, sourceEndLine = element?.dataset.sourceEndLine;
      const mappedAttribute = (value: string | undefined) => {
        if (value === undefined || !mapSourceLine) return value;
        const mapped = mapSourceLine(Number(value));
        return mapped === undefined ? null : String(mapped);
      };
      const expectedLine = mappedAttribute(sourceLine), expectedEndLine = mappedAttribute(sourceEndLine);
      if (expectedLine === null || expectedEndLine === null) continue;
      const block = text.parentElement!.closest<HTMLElement>('p,li,td,th,pre,h1,h2,h3,h4,h5,h6,summary');
      const blockRect = block?.getBoundingClientRect();
      return () => {
        if (!text.isConnected || text.ownerDocument !== document || text.data !== value
          || element && (element.dataset.sourceLine !== expectedLine || element.dataset.sourceEndLine !== expectedEndLine)) return false;
        // A DOM move adjusts live Range boundaries to the old parent even when
        // morphing retains the same text node. Recreate from immutable coordinates.
        const currentRange = document.createRange();
        currentRange.setStart(text, offset); currentRange.collapse(true);
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
  return null;
}
