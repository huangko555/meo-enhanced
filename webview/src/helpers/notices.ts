import { AlertTriangle, Info, X, XCircle, createElement } from 'lucide';
import type {
  EditorNotice,
  EditorNoticeAction,
  EditorNoticeContent,
  EditorNoticeKind
} from './errors';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';

const normalizeNotice = (notice: string | EditorNoticeContent): EditorNoticeContent => (
  typeof notice === 'string' ? { message: notice } : notice
);

const createNoticeIcon = (kind: EditorNoticeKind): SVGElement => {
  const icon = kind === 'error' ? XCircle : kind === 'warning' ? AlertTriangle : Info;
  return createElement(icon, {
    width: 18,
    height: 18,
    'stroke-width': 2,
    'aria-hidden': 'true'
  });
};

export function createEditorNoticeController(
  banner: HTMLElement,
  uiLanguage: UiLanguage,
  onDismiss?: () => void
): EditorNotice & { setUiLanguage: (language: UiLanguage) => void } {
  let activeLanguage = uiLanguage;
  let activeKind: EditorNoticeKind = 'info';
  let activeNotice: EditorNoticeContent | null = null;
  let renderVersion = 0;

  const icon = document.createElement('span');
  icon.className = 'editor-notice-icon';
  icon.setAttribute('aria-hidden', 'true');

  const content = document.createElement('div');
  content.className = 'editor-notice-content';
  const title = document.createElement('div');
  title.className = 'editor-notice-title';
  const message = document.createElement('div');
  message.className = 'editor-notice-message';
  content.append(title, message);

  const actions = document.createElement('div');
  actions.className = 'editor-notice-actions';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'editor-notice-button editor-notice-close';

  const updateCloseButton = (): void => {
    const strings = getUiStrings(activeLanguage);
    closeButton.title = strings.dismissNotification;
    closeButton.setAttribute('aria-label', strings.dismissNotification);
    closeButton.replaceChildren(
      createElement(X, { width: 14, height: 14, 'stroke-width': 2, 'aria-hidden': 'true' }),
      document.createTextNode(strings.dismissNotificationButton)
    );
  };

  const defaultTitle = (kind: EditorNoticeKind): string => {
    const strings = getUiStrings(activeLanguage);
    if (kind === 'error') return strings.noticeErrorTitle;
    if (kind === 'warning') return strings.noticeWarningTitle;
    return strings.noticeInfoTitle;
  };

  const createActionButton = (action: EditorNoticeAction, version: number): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'editor-notice-button editor-notice-action';
    button.dataset.action = action.id;
    button.dataset.emphasis = action.emphasis ?? 'secondary';
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const actionButtons = actions.querySelectorAll<HTMLButtonElement>('.editor-notice-action');
      actionButtons.forEach((candidate) => { candidate.disabled = true; });
      banner.setAttribute('aria-busy', 'true');
      try {
        if (version === renderVersion && activeNotice) message.textContent = activeNotice.message;
        await action.run();
      } catch (error) {
        console.error('[MEO webview] notice action failed', { action: action.id, error });
        if (version === renderVersion && activeNotice && !banner.hidden) {
          const detail = error instanceof Error ? error.message : String(error);
          message.textContent = activeNotice.message + ' ' +
            getUiStrings(activeLanguage).noticeActionFailed + ' ' + detail;
        }
      } finally {
        if (version === renderVersion && !banner.hidden) {
          actionButtons.forEach((candidate) => { candidate.disabled = false; });
          banner.removeAttribute('aria-busy');
        }
      }
    });
    return button;
  };

  updateCloseButton();
  actions.append(closeButton);
  banner.replaceChildren(icon, content, actions);
  banner.setAttribute('aria-atomic', 'true');

  const clearEditorNotice = (): void => {
    renderVersion += 1;
    activeNotice = null;
    title.textContent = '';
    message.textContent = '';
    delete banner.dataset.kind;
    banner.removeAttribute('aria-busy');
    banner.hidden = true;
    banner.classList.remove('is-visible');
    actions.replaceChildren(closeButton);
  };

  const setEditorNotice = (
    notice: string | EditorNoticeContent,
    kind: EditorNoticeKind = 'info'
  ): void => {
    const normalized = normalizeNotice(notice);
    const normalizedMessage = `${normalized.message ?? ''}`.trim();
    if (!normalizedMessage) {
      clearEditorNotice();
      return;
    }
    renderVersion += 1;
    const version = renderVersion;
    activeKind = kind;
    activeNotice = normalized;
    title.textContent = `${normalized.title ?? ''}`.trim() || defaultTitle(kind);
    message.textContent = normalizedMessage;
    icon.replaceChildren(createNoticeIcon(kind));
    actions.replaceChildren(
      ...(normalized.actions ?? []).map((action) => createActionButton(action, version)),
      closeButton
    );
    banner.dataset.kind = kind;
    banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    banner.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    banner.removeAttribute('aria-busy');
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
      activeLanguage = language;
      updateCloseButton();
      if (activeNotice && !activeNotice.title) title.textContent = defaultTitle(activeKind);
    }
  };
}
