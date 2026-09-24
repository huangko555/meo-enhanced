export type EditorNoticeKind = 'info' | 'warning' | 'error';

export type EditorNoticeAction = Readonly<{
  id: string;
  label: string;
  run: () => void | Promise<void>;
  emphasis?: 'primary' | 'secondary';
}>;

export type EditorNoticeContent = Readonly<{
  message: string;
  title?: string;
  actions?: readonly EditorNoticeAction[];
}>;

export interface EditorNotice {
  setEditorNotice: (notice: string | EditorNoticeContent, kind?: EditorNoticeKind) => void;
  clearEditorNotice: () => void;
}

export const getErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return '';
};

export const isTransientMermaidRuntimeError = (error: unknown): boolean => {
  const message = getErrorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }
  if (!message.includes('mermaid')) {
    return false;
  }
  return (
    message.includes('runtime') ||
    message.includes('failed to load') ||
    message.includes('missing') ||
    message.includes('unavailable') ||
    message.includes('script')
  );
};

export const shouldAutoFallbackToSourceForLiveError = (error: unknown): boolean => !isTransientMermaidRuntimeError(error);

export const logWebviewRenderError = (context: string, error: unknown, extra: Record<string, unknown> = {}): void => {
  console.error('[MEO webview] render error', {
    context,
    ...extra,
    error
  });
};

export interface FailureNoticeState {
  message: NoticeMessage;
  kind: EditorNoticeKind;
  key: string | null;
}

export type NoticeContent = string | EditorNoticeContent;
export type NoticeMessage = NoticeContent | (() => NoticeContent);

export const createFailureNoticeManager = (notice: EditorNotice) => {
  let failureNotice: FailureNoticeState = { message: '', kind: 'error', key: null };
  let persistentNotice: FailureNoticeState = { message: '', kind: 'warning', key: null };
  let dismissedFailureKey: string | null = null;
  let dismissedPersistentKey: string | null = null;

  const resolveMessage = (message: NoticeMessage): NoticeContent => (
    typeof message === 'function' ? message() : message
  );

  const updateEditorNotice = () => {
    const activeNotice = failureNotice.message ? failureNotice : persistentNotice;
    if (activeNotice.message) {
      notice.setEditorNotice(resolveMessage(activeNotice.message), activeNotice.kind);
      return;
    }
    notice.clearEditorNotice();
  };

  const setFailureNotice = (
    message: NoticeMessage,
    kind: EditorNoticeKind = 'error',
    key: string | null = null
  ): void => {
    if (key !== null && dismissedFailureKey === key) return;
    const duplicate = key !== null
      && Boolean(failureNotice.message)
      && failureNotice.key === key
      && failureNotice.kind === kind;
    if (key !== dismissedFailureKey) dismissedFailureKey = null;
    failureNotice = { message, kind, key };
    if (duplicate) return;
    updateEditorNotice();
  };

  const clearFailureNotice = (key: string | null = null): void => {
    if (key !== null && failureNotice.key !== key) {
      if (dismissedFailureKey === key) dismissedFailureKey = null;
      return;
    }
    if (!failureNotice.message) {
      if (key === null || dismissedFailureKey === key) dismissedFailureKey = null;
      return;
    }
    failureNotice = { message: '', kind: 'error', key: null };
    if (key === null || dismissedFailureKey === key) dismissedFailureKey = null;
    updateEditorNotice();
  };

  const setPersistentNotice = (
    message: NoticeMessage,
    kind: EditorNoticeKind = 'warning',
    key: string | null = null
  ): void => {
    if (key !== null && dismissedPersistentKey === key) return;
    const duplicate = key !== null
      && Boolean(persistentNotice.message)
      && persistentNotice.key === key
      && persistentNotice.kind === kind;
    if (key !== dismissedPersistentKey) dismissedPersistentKey = null;
    persistentNotice = { message, kind, key };
    if (duplicate) return;
    updateEditorNotice();
  };

  const clearPersistentNotice = (key: string | null = null): void => {
    if (key !== null && persistentNotice.key !== key) {
      if (dismissedPersistentKey === key) dismissedPersistentKey = null;
      return;
    }
    if (!persistentNotice.message) {
      if (key === null || dismissedPersistentKey === key) dismissedPersistentKey = null;
      return;
    }
    persistentNotice = { message: '', kind: 'warning', key: null };
    if (key === null || dismissedPersistentKey === key) dismissedPersistentKey = null;
    updateEditorNotice();
  };

  const dismissCurrentNotice = (): void => {
    if (failureNotice.message) {
      dismissedFailureKey = failureNotice.key;
      failureNotice = { message: '', kind: 'error', key: null };
      updateEditorNotice();
      return;
    }
    if (!persistentNotice.message) return;
    dismissedPersistentKey = persistentNotice.key;
    persistentNotice = { message: '', kind: 'warning', key: null };
    updateEditorNotice();
  };

  const hasFailureNotice = (): boolean => Boolean(failureNotice.message);

  return {
    setFailureNotice,
    clearFailureNotice,
    setPersistentNotice,
    clearPersistentNotice,
    dismissCurrentNotice,
    hasFailureNotice,
    updateEditorNotice
  };
};

export type FailureNoticeManager = ReturnType<typeof createFailureNoticeManager>;
