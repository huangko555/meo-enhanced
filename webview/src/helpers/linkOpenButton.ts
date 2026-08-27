import { createElement, ExternalLink, SquareArrowRightEnter } from 'lucide';
import { getUiStrings, type UiLanguage } from '../../../src/foundation/uiLanguage';

export function createOpenLinkButton(href: string, language: UiLanguage = 'en'): HTMLButtonElement {
  const isDocumentFragment = href.startsWith('#');
  const strings = getUiStrings(language);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-md-link-open-btn';
  button.title = isDocumentFragment ? strings.jumpWithinDocument : strings.openLink;
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
