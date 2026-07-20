import { createElement, ExternalLink, SquareArrowRightEnter } from 'lucide';

export function createOpenLinkButton(href: string): HTMLButtonElement {
  const isDocumentFragment = href.startsWith('#');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-md-link-open-btn';
  button.title = isDocumentFragment ? 'Jump within document' : 'Open link';
  button.setAttribute('aria-label', button.title);
  button.appendChild(createElement(isDocumentFragment ? SquareArrowRightEnter : ExternalLink, { 'aria-hidden': 'true' }));
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.dispatchEvent(new CustomEvent('meo-open-link', {
      bubbles: true,
      detail: { href }
    }));
  });
  return button;
}
