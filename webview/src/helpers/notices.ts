import type { EditorNotice } from './errors';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';

export function createEditorNoticeController(
  banner: HTMLElement,
  uiLanguage: UiLanguage,
  onDismiss?: () => void
): EditorNotice & { setUiLanguage: (language: UiLanguage) => void } {
  const strings = getUiStrings(uiLanguage);
  const message = document.createElement('span');
  message.className = 'editor-notice-message';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'editor-notice-close';
  closeButton.textContent = '×';
  closeButton.title = strings.dismissNotification;
  closeButton.setAttribute('aria-label', strings.dismissNotification);
  banner.replaceChildren(message, closeButton);

  const clearEditorNotice = (): void => {
    message.textContent = '';
    delete banner.dataset.kind;
    banner.hidden = true;
    banner.classList.remove('is-visible');
  };

  const setEditorNotice = (notice: string, kind = 'info'): void => {
    const normalizedMessage = `${notice ?? ''}`.trim();
    if (!normalizedMessage) {
      clearEditorNotice();
      return;
    }
    message.textContent = normalizedMessage;
    banner.dataset.kind = kind;
    banner.hidden = false;
    banner.classList.add('is-visible');
  };

  closeButton.addEventListener('click', () => {
    clearEditorNotice();
    onDismiss?.();
  });
  return {
    setEditorNotice,
    clearEditorNotice,
    setUiLanguage: (language) => {
      const label = getUiStrings(language).dismissNotification;
      closeButton.title = label;
      closeButton.setAttribute('aria-label', label);
    }
  };
}
