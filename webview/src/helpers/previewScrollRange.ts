/** Estimated offscreen heights can change while Chromium owns a native
 * scrollbar gesture. Keep its range stable until release, without replacing
 * native pointer handling or changing the rendered content's normal flow. */
export function createPreviewScrollRange(document: Document) {
  const page = document.querySelector<HTMLElement>('.meo-export-page');
  const properties = ['height', 'overflow', 'box-sizing', 'overflow-anchor'] as const;
  const owner = document.defaultView;
  let held: { pointer: number; startY: number; styles: Array<{ value: string; priority: string }> } | null = null;
  let boundary: 'top' | 'bottom' | null = null;
  let boundaryFrame: number | null = null;
  const interrupt = () => {
    boundary = null;
    if (boundaryFrame !== null) owner?.cancelAnimationFrame(boundaryFrame);
    boundaryFrame = null;
  };
  const pinBoundary = () => {
    const scroll = document.scrollingElement;
    if (!boundary || !scroll || !page?.isConnected) return;
    const position = boundary === 'top' ? 0 : Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (Math.abs(scroll.scrollTop - position) > 1) scroll.scrollTop = position;
  };
  // Releasing the thumb can reveal estimated blocks and start nearby resource
  // presentation. Preserve the chosen edge across that later height change,
  // until another user navigation owns the reading position.
  const scheduleBoundary = () => {
    if (!boundary || !owner || boundaryFrame !== null) return;
    boundaryFrame = owner.requestAnimationFrame(() => { boundaryFrame = null; pinBoundary(); });
  };
  const observer = new ResizeObserver(scheduleBoundary);
  if (page) observer.observe(page);
  // Root anchoring can settle after the final size notification. A later
  // browser scroll correction must honor the same boundary owner too.
  document.addEventListener('scroll', scheduleBoundary, { passive: true });
  const restore = (keepBoundary: boolean, releaseY?: number) => {
    if (!page || !held) return;
    const scroll = document.scrollingElement;
    // Chromium may adjust the anchor while estimated blocks resolve, even
    // within a fixed page height. A thumb deliberately dragged to the track's
    // edge still means that edge; a stationary arrow/track click does not.
    const gutter = (owner?.innerWidth ?? 0) - document.documentElement.clientWidth;
    const draggedToBottom = releaseY !== undefined && releaseY > held.startY + Math.max(4, gutter)
      && !!scroll && releaseY >= scroll.clientHeight - Math.max(3, gutter);
    const draggedToTop = releaseY !== undefined && releaseY < held.startY - Math.max(4, gutter)
      && releaseY <= Math.max(3, gutter);
    const nextBoundary = draggedToTop ? 'top' : draggedToBottom ? 'bottom'
      : scroll && scroll.scrollTop <= 2 ? 'top'
      : scroll && scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2 ? 'bottom' : null;
    const previous = held;
    held = null;
    for (const [index, property] of properties.entries()) {
      const style = previous.styles[index];
      if (style.value) page.style.setProperty(property, style.value, style.priority);
      else page.style.removeProperty(property);
    }
    if (keepBoundary && nextBoundary && scroll && page.isConnected) {
      boundary = nextBoundary;
      pinBoundary();
    }
  };
  return {
    start(event: Pick<PointerEvent, 'button' | 'pointerId' | 'clientX' | 'clientY'>) {
      interrupt();
      const width = document.defaultView?.innerWidth ?? 0;
      if (!page || held || event.button !== 0 || event.clientX < document.documentElement.clientWidth || event.clientX >= width) return;
      const height = page.getBoundingClientRect().height;
      held = { pointer: event.pointerId, startY: event.clientY, styles: properties.map(property => ({
        value: page.style.getPropertyValue(property), priority: page.style.getPropertyPriority(property)
      })) };
      page.style.setProperty('box-sizing', 'border-box', 'important');
      page.style.setProperty('height', `${height}px`, 'important');
      page.style.setProperty('overflow', 'clip', 'important');
      page.style.setProperty('overflow-anchor', 'none', 'important');
    },
    release(pointer?: number, clientY?: number) {
      if (pointer === undefined || held?.pointer === pointer) restore(true, clientY);
    },
    interrupt,
    cancel(pointer?: number) {
      if (pointer === undefined || !held || held.pointer === pointer) { interrupt(); restore(false); }
    },
    dispose() { interrupt(); restore(false); observer.disconnect(); document.removeEventListener('scroll', scheduleBoundary); }
  };
}
