type FocusableEditor = {
  readonly view: { readonly dom: HTMLElement };
  hasFocus(): boolean;
  focus(): void;
};

export type EditorFocusController = {
  restoreFromHost(): boolean;
  dispose(): void;
};

const focusTakingSelector = 'input, textarea, select, [role="textbox"], [role="combobox"], [role="listbox"], [role="option"], [contenteditable]:not([contenteditable="false"])';
const focusTransferSelector = 'iframe, dialog[open], [aria-modal="true"], [draggable="true"]';
const windowReturnDelayMs = 160;

/** Owns focus handoffs between an editable document, window activation, and Webview chrome. */
export function createEditorFocusController({
  root,
  getEditor,
  isEditableMode
}: {
  root: HTMLElement;
  getEditor: () => FocusableEditor | null;
  isEditableMode: () => boolean;
}): EditorFocusController {
  let editorWasLastFocused = false;
  let documentPointerGeneration = 0;
  let transientOrigin = false;
  let transientReturnFrame: number | null = null;
  let hostReturnFrame: number | null = null;
  let windowReturnTimer: number | null = null;
  let restoreOnWindowReturn = false;
  let windowReturnPending = false;
  let windowReturnPointerGeneration = 0;
  let windowReturnGeneration = 0;
  let lastWindowReturnPointerAt = -Infinity;

  const editorDom = (): HTMLElement | null => getEditor()?.view.dom ?? null;
  const inEditor = (target: EventTarget | null): boolean => (
    target instanceof Node && editorDom()?.contains(target) === true
  );
  const isFocusTaking = (target: Element): boolean => Boolean(target.closest(focusTakingSelector));
  const isFocusTransfer = (target: Element): boolean => Boolean(target.closest(focusTransferSelector));
  const clearTransientFrame = (): void => {
    if (transientReturnFrame !== null) window.cancelAnimationFrame(transientReturnFrame);
    transientReturnFrame = null;
  };
  const restoreAfterTransient = (): void => {
    if (!transientOrigin || transientReturnFrame !== null) return;
    const pointerGeneration = documentPointerGeneration;
    transientReturnFrame = window.requestAnimationFrame(() => {
      transientReturnFrame = null;
      if (!transientOrigin || !isEditableMode() || documentPointerGeneration !== pointerGeneration || windowReturnPending) return;
      const active = document.activeElement;
      if (inEditor(active)) {
        transientOrigin = false;
        return;
      }
      if (active instanceof Element) {
        if (active.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])')) return;
        if (active.matches('[role="combobox"][aria-expanded="true"]')) return;
        if (active.closest('[role="listbox"]:not([hidden])')) return;
        if (active !== document.body && active !== document.documentElement && !root.contains(active)) {
          transientOrigin = false;
          return;
        }
      }
      transientOrigin = false;
      getEditor()?.focus();
    });
  };

  const scheduleHostReturn = (): void => {
    if (windowReturnPending) {
      if (documentPointerGeneration !== windowReturnPointerGeneration || windowReturnTimer !== null) return;
      const generation = windowReturnGeneration;
      windowReturnTimer = window.setTimeout(() => {
        if (generation !== windowReturnGeneration) return;
        windowReturnTimer = null;
        windowReturnPending = false;
        root.classList.remove('meo-window-focus-return-pending');
        if (documentPointerGeneration === windowReturnPointerGeneration) scheduleHostReturn();
      }, windowReturnDelayMs);
      return;
    }
    if (performance.now() - lastWindowReturnPointerAt < windowReturnDelayMs) return;
    if (hostReturnFrame !== null) window.cancelAnimationFrame(hostReturnFrame);
    const pointerGeneration = documentPointerGeneration;
    hostReturnFrame = window.requestAnimationFrame(() => {
      hostReturnFrame = null;
      if (!isEditableMode() || documentPointerGeneration !== pointerGeneration) return;
      const editor = getEditor();
      if (!editor) return;
      const active = document.activeElement;
      if (active !== document.body && active !== document.documentElement && !editor.hasFocus()) return;
      editor.focus();
    });
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (inEditor(target)) {
      documentPointerGeneration += 1;
      transientOrigin = false;
      clearTransientFrame();
      if (windowReturnPending) {
        windowReturnPending = false;
        if (windowReturnTimer !== null) window.clearTimeout(windowReturnTimer);
        windowReturnTimer = null;
        lastWindowReturnPointerAt = performance.now();
        const generation = windowReturnGeneration;
        window.requestAnimationFrame(() => {
          if (generation === windowReturnGeneration) root.classList.remove('meo-window-focus-return-pending');
        });
      }
      return;
    }
    if (isFocusTransfer(target)) {
      transientOrigin = false;
      clearTransientFrame();
      return;
    }
    if (!root.contains(target)) {
      if (!target.closest('.preview-dropdown-panel')) transientOrigin = false;
      return;
    }
    if (isFocusTaking(target)) {
      if (getEditor()?.hasFocus()) transientOrigin = true;
      return;
    }
    if (event.button === 0 && isEditableMode() && getEditor()?.hasFocus()) event.preventDefault();
  };

  const onFocusIn = (event: FocusEvent): void => {
    if (inEditor(event.target)) {
      editorWasLastFocused = true;
      transientOrigin = false;
      clearTransientFrame();
      return;
    }
    const target = event.target;
    if (target instanceof Element && root.contains(target) && isFocusTaking(target)) {
      if (inEditor(event.relatedTarget)) transientOrigin = true;
    }
    editorWasLastFocused = false;
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (!transientOrigin || inEditor(event.target)) return;
    restoreAfterTransient();
  };
  const onClick = (): void => {
    if (!transientOrigin) return;
    const active = document.activeElement;
    if (active instanceof Element && active.matches('[role="combobox"][aria-expanded="false"]')) restoreAfterTransient();
  };
  const onKeyDownCapture = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    transientOrigin = false;
    clearTransientFrame();
  };
  const onKeyDownBubble = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') onClick();
  };
  const onWindowBlur = (): void => {
    restoreOnWindowReturn = getEditor()?.hasFocus() === true || editorWasLastFocused;
    windowReturnGeneration += 1;
    if (windowReturnTimer !== null) window.clearTimeout(windowReturnTimer);
    windowReturnTimer = null;
    if (hostReturnFrame !== null) window.cancelAnimationFrame(hostReturnFrame);
    hostReturnFrame = null;
    windowReturnPending = restoreOnWindowReturn;
    windowReturnPointerGeneration = documentPointerGeneration;
    lastWindowReturnPointerAt = -Infinity;
    root.classList.toggle('meo-window-focus-return-pending', windowReturnPending);
  };
  const onWindowFocus = (): void => {
    if (!restoreOnWindowReturn) return;
    restoreOnWindowReturn = false;
    scheduleHostReturn();
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDownCapture, true);
  document.addEventListener('keydown', onKeyDownBubble);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);

  return {
    restoreFromHost(): boolean {
      const editor = getEditor();
      if (!editor) return false;
      const active = document.activeElement;
      if (active !== document.body && active !== document.documentElement && !editor.hasFocus()) return false;
      scheduleHostReturn();
      return true;
    },
    dispose(): void {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDownCapture, true);
      document.removeEventListener('keydown', onKeyDownBubble);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      clearTransientFrame();
      if (hostReturnFrame !== null) window.cancelAnimationFrame(hostReturnFrame);
      if (windowReturnTimer !== null) window.clearTimeout(windowReturnTimer);
      root.classList.remove('meo-window-focus-return-pending');
    }
  };
}
