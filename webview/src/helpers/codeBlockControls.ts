import { createElement, Copy, Check, TextCursorInput } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';

export function createCopyCodeButton(
  codeContent: string | (() => string),
  language: UiLanguage
): HTMLSpanElement {
  const strings = getUiStrings(language);
  const button = document.createElement('span');
  button.className = 'meo-code-block-pill meo-copy-code-btn';
  button.setAttribute('aria-label', strings.copyCode);
  button.dataset.tooltip = strings.copyCode;
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  const updateIcon = (copied: boolean) => {
    button.replaceChildren(createElement(copied ? Check : Copy, {
      width: 15, height: 15, 'aria-hidden': 'true'
    }));
    button.classList.toggle('copied', copied);
  };
  updateIcon(false);

  const copy = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(
        typeof codeContent === 'function' ? codeContent() : codeContent
      );
      updateIcon(true);
      setTimeout(() => updateIcon(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  button.addEventListener('click', copy);
  button.addEventListener('keydown', async (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      await copy(event);
    }
  });

  return button;
}

export function createSelectAllCodeButton(onSelectAll: () => void, language: UiLanguage): HTMLSpanElement {
  const strings = getUiStrings(language);
  const button = document.createElement('span');
  button.className = 'meo-code-block-pill meo-select-all-code-btn';
  button.setAttribute('aria-label', strings.selectAllCode);
  button.dataset.tooltip = strings.selectAllCode;
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.appendChild(createElement(TextCursorInput, { width: 15, height: 15, 'aria-hidden': 'true' }));

  const selectAll = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectAll();
  };

  button.addEventListener('click', selectAll);
  button.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      selectAll(event);
    }
  });

  return button;
}
