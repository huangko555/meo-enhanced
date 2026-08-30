import { getUiStrings, type UiLanguage } from '../application/uiLanguage';

export function createCopyCodeButton(
  codeContent: string | (() => string),
  language: UiLanguage
): HTMLSpanElement {
  const strings = getUiStrings(language);
  const button = document.createElement('span');
  button.className = 'meo-code-block-pill meo-copy-code-btn';
  button.setAttribute('aria-label', strings.copyCode);
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.textContent = strings.copy;

  const updateText = (copied: boolean) => {
    button.textContent = copied ? strings.copied : strings.copy;
    button.classList.toggle('copied', copied);
  };

  const copy = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(
        typeof codeContent === 'function' ? codeContent() : codeContent
      );
      updateText(true);
      setTimeout(() => updateText(false), 2000);
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
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.textContent = strings.all;

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
