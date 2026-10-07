import { createElement, ExternalLink, SquareArrowRightEnter } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';

export function createOpenLinkButton(href: string, language: UiLanguage): HTMLButtonElement {
  const isDocumentFragment = href.startsWith('#');
  const strings = getUiStrings(language);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-md-link-open-btn';
  button.dataset.tooltip = href;
  button.dataset.tooltipLinkHref = href;
  button.dataset.tooltipKind = 'description';
  button.setAttribute('aria-label', isDocumentFragment ? strings.jumpWithinDocument : strings.openLink);
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
