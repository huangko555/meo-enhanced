export interface EditorNotice {
  setEditorNotice: (message: string, kind?: string) => void;
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
  kind: string;
}

export type NoticeMessage = string | (() => string);

export const createFailureNoticeManager = (notice: EditorNotice) => {
  let failureNotice: FailureNoticeState = { message: '', kind: 'error' };
  let persistentNotice: FailureNoticeState = { message: '', kind: 'warning' };

  const resolveMessage = (message: NoticeMessage): string => (
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

  const setFailureNotice = (message: NoticeMessage, kind: 'error' | 'warning' = 'error'): void => {
    failureNotice = { message, kind };
    updateEditorNotice();
  };

  const clearFailureNotice = (): void => {
    if (!failureNotice.message) {
      return;
    }
    failureNotice = { message: '', kind: 'error' };
    updateEditorNotice();
  };

  const setPersistentNotice = (message: NoticeMessage, kind: 'warning' = 'warning'): void => {
    persistentNotice = { message, kind };
    updateEditorNotice();
  };

  const clearPersistentNotice = (): void => {
    if (!persistentNotice.message) return;
    persistentNotice = { message: '', kind: 'warning' };
    updateEditorNotice();
  };

  const dismissCurrentNotice = (): void => {
    if (failureNotice.message) {
      clearFailureNotice();
      return;
    }
    clearPersistentNotice();
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
