import type { EditorNotice } from './errors';

export function createEditorNoticeController(banner: HTMLElement, onDismiss?: () => void): EditorNotice {
  const message = document.createElement('span');
  message.className = 'editor-notice-message';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'editor-notice-close';
  closeButton.textContent = '×';
  closeButton.title = 'Dismiss notification';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
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
  return { setEditorNotice, clearEditorNotice };
}
