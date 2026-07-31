import { ChevronsUp, createElement } from 'lucide';

type ScrollElement = Element & { scrollTop: number };

export function createDocumentScrollToTopController() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'document-scroll-top';
  button.title = 'Back to top';
  button.setAttribute('aria-label', 'Back to top');
  button.appendChild(createElement(ChevronsUp, {
    width: 21,
    height: 21,
    'aria-hidden': 'true'
  }));
  button.hidden = true;

  let scrollElement: ScrollElement | null = null;
  let scrollEventTarget: EventTarget | null = null;

  const sync = () => {
    button.hidden = !scrollElement || scrollElement.scrollTop <= 0.5;
  };
  const onScroll = () => sync();

  const setScrollElement = (element: Element | null, eventTarget: EventTarget | null = element) => {
    scrollEventTarget?.removeEventListener('scroll', onScroll);
    scrollElement = element && 'scrollTop' in element ? element as ScrollElement : null;
    scrollEventTarget = scrollElement ? eventTarget : null;
    scrollEventTarget?.addEventListener('scroll', onScroll, { passive: true });
    sync();
  };

  button.addEventListener('pointerdown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    if (!scrollElement) {
      return;
    }
    scrollElement.scrollTop = 0;
    sync();
  });

  return {
    button,
    setScrollElement,
    sync
  };
}
