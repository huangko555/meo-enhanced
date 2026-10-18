/** Estimated offscreen heights can change while Chromium owns a native
 * scrollbar gesture. Keep its range stable until release, without replacing
 * native pointer handling or changing the rendered content's normal flow. */
export function createPreviewScrollRange(document: Document) {
  const page = document.querySelector<HTMLElement>('.meo-export-page');
  const properties = ['height', 'overflow', 'box-sizing'] as const;
  let held: { pointer: number; styles: Array<{ value: string; priority: string }> } | null = null;
  const restore = (keepBoundary: boolean) => {
    if (!page || !held) return;
    const scroll = document.scrollingElement;
    const atBottom = !!scroll && scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2;
    const previous = held;
    held = null;
    for (const [index, property] of properties.entries()) {
      const style = previous.styles[index];
      if (style.value) page.style.setProperty(property, style.value, style.priority);
      else page.style.removeProperty(property);
    }
    if (keepBoundary && atBottom && scroll && page.isConnected) {
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    }
  };
  return {
    start(event: Pick<PointerEvent, 'button' | 'pointerId' | 'clientX'>) {
      const width = document.defaultView?.innerWidth ?? 0;
      if (!page || held || event.button !== 0 || event.clientX < document.documentElement.clientWidth || event.clientX >= width) return;
      const height = page.getBoundingClientRect().height;
      held = { pointer: event.pointerId, styles: properties.map(property => ({
        value: page.style.getPropertyValue(property), priority: page.style.getPropertyPriority(property)
      })) };
      page.style.setProperty('box-sizing', 'border-box', 'important');
      page.style.setProperty('height', `${height}px`, 'important');
      page.style.setProperty('overflow', 'clip', 'important');
    },
    release(pointer?: number) {
      if (pointer === undefined || held?.pointer === pointer) restore(true);
    },
    dispose() { restore(false); }
  };
}
