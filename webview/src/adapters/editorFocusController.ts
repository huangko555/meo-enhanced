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
const windowReturnPaintGraceMs = 50;

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
  let leftAltGesture: { usedInCombination: boolean } | null = null;
  let documentPointerGeneration = 0;
  let transientOrigin = false;
  let transientReturnFrame: number | null = null;
  let windowReturnFrame: number | null = null;
  let windowReturnPaintTimer: number | null = null;
  let restoreOnWindowReturn = false;
  let windowReturnPending = false;
  let windowReturnPointerGeneration: number | null = 0;
  let windowReturnGeneration = 0;

  const editorDom = (): HTMLElement | null => getEditor()?.view.dom ?? null;
  const inEditor = (target: EventTarget | null): boolean => (
    target instanceof Node && editorDom()?.contains(target) === true
  );
  const isEditableInput = (target: EventTarget | null): boolean => (
    isEditableMode() && inEditor(target) && target instanceof HTMLElement && (
      target.isContentEditable
      || ((target instanceof HTMLTextAreaElement
        || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(target.type)))
        && !target.readOnly && !target.disabled)
    )
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

  const clearWindowReturnPaint = (): void => {
    if (windowReturnFrame !== null) window.cancelAnimationFrame(windowReturnFrame);
    windowReturnFrame = null;
    if (windowReturnPaintTimer !== null) window.clearTimeout(windowReturnPaintTimer);
    windowReturnPaintTimer = null;
  };
  const finishWindowReturn = (): void => {
    clearWindowReturnPaint();
    windowReturnPending = false;
    restoreOnWindowReturn = false;
    root.classList.remove('meo-window-focus-return-pending');
  };
  const settleWindowReturnBeforePaint = (activationClick = false): void => {
    if (!windowReturnPending || windowReturnFrame !== null || windowReturnPaintTimer !== null) return;
    const generation = windowReturnGeneration;
    const beforePaint = () => {
      if (generation !== windowReturnGeneration) return;
      windowReturnPaintTimer = null;
      windowReturnFrame = window.requestAnimationFrame(() => {
        if (generation !== windowReturnGeneration) return;
        windowReturnFrame = null;
        finishWindowReturn();
      });
    };
    // Window activation can arrive before the click in a later frame.
    // This bound guards only paint: input stays focused, and a click or key
    // ends the guard early. Duplicate Host/focus signals never extend it.
    if (activationClick) beforePaint();
    else windowReturnPaintTimer = window.setTimeout(beforePaint, windowReturnPaintGraceMs);
  };
  const restoreWindowReturn = (): boolean => {
    if (!isEditableMode()) {
      finishWindowReturn();
      return false;
    }
    const editor = getEditor();
    if (!editor) return false;
    const active = document.activeElement;
    if (inEditor(active)) {
      // Native activation or a new click already owns this selection. A late
      // Host notification must not reapply the target saved before blur.
      settleWindowReturnBeforePaint();
      return true;
    }
    if (active !== document.body && active !== document.documentElement) return false;
    if (documentPointerGeneration !== windowReturnPointerGeneration) return false;
    // An active VS Code panel can still leave keyboard focus in another Webview.
    if (!document.hasFocus()) return false;
    // Input must be connected synchronously. Only painting waits for the
    // activation click's native selection to finish, never the first key.
    editor.focus();
    settleWindowReturnBeforePaint();
    return true;
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (inEditor(target)) {
      documentPointerGeneration += 1;
      transientOrigin = false;
      clearTransientFrame();
      restoreOnWindowReturn = false;
      if (windowReturnPending) {
        windowReturnGeneration += 1;
        clearWindowReturnPaint();
        settleWindowReturnBeforePaint(true);
      }
      return;
    }
    windowReturnPointerGeneration = null;
    finishWindowReturn();
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
      restoreOnWindowReturn = false;
      settleWindowReturnBeforePaint();
      return;
    }
    windowReturnPointerGeneration = null;
    finishWindowReturn();
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
  const onInputCapture = (event: Event): void => {
    if (event.type === 'compositionstart' && leftAltGesture) leftAltGesture.usedInCombination = true;
    if (!windowReturnPending) return;
    if (inEditor(event.target)) {
      finishWindowReturn();
    } else if (restoreWindowReturn()) {
      finishWindowReturn();
    }
  };
  const onKeyDownCapture = (event: KeyboardEvent): void => {
    const leftAlt = event.key === 'Alt' && event.code === 'AltLeft';
    if (leftAltGesture && !leftAlt) leftAltGesture.usedInCombination = true;
    if (leftAlt && navigator.platform.startsWith('Win') && isEditableInput(event.target)
      && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && !event.isComposing && !event.getModifierState('AltGraph')) {
      if (!event.repeat) leftAltGesture = { usedInCombination: false };
      if (leftAltGesture && !leftAltGesture.usedInCombination) {
        // VS Code forwards Webview window events even when defaultPrevented.
        // Keep bare Alt inside the editing surface before it enters the menu.
        event.preventDefault();
        event.stopPropagation();
      }
    }
    if (event.key === 'Tab') {
      transientOrigin = false;
      clearTransientFrame();
      finishWindowReturn();
      return;
    }
    if (!['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) onInputCapture(event);
  };
  const onKeyDownBubble = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') onClick();
  };
  const onKeyUpCapture = (event: KeyboardEvent): void => {
    // Alt release, when delivered to the Webview, confirms a keyboard return
    // without waiting for the unknown-activation paint bound.
    if (event.key === 'Alt') onInputCapture(event);
    if (event.key !== 'Alt' || event.code !== 'AltLeft') return;
    const suppress = leftAltGesture && !leftAltGesture.usedInCombination
      && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && !event.isComposing && !event.getModifierState('AltGraph');
    leftAltGesture = null;
    if (suppress) {
      // Pair with the consumed down even after a focus/window handoff. An OS
      // switch may hide Tab; forwarding the unmatched up could focus the menu.
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onWindowBlur = (): void => {
    restoreOnWindowReturn = getEditor()?.hasFocus() === true || editorWasLastFocused;
    windowReturnGeneration += 1;
    clearWindowReturnPaint();
    clearTransientFrame();
    windowReturnPending = restoreOnWindowReturn;
    windowReturnPointerGeneration = restoreOnWindowReturn ? documentPointerGeneration : null;
    root.classList.toggle('meo-window-focus-return-pending', windowReturnPending);
  };
  const onWindowFocus = (): void => {
    if (!restoreOnWindowReturn) return;
    restoreOnWindowReturn = false;
    restoreWindowReturn();
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDownCapture, true);
  document.addEventListener('keyup', onKeyUpCapture, true);
  document.addEventListener('beforeinput', onInputCapture, true);
  document.addEventListener('compositionstart', onInputCapture, true);
  document.addEventListener('keydown', onKeyDownBubble);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);

  return {
    restoreFromHost(): boolean {
      // Panel/activity notifications may arrive after a Workbench control took
      // focus. Only a native return into this document may grant focus again.
      if (!document.hasFocus()) return false;
      return restoreWindowReturn();
    },
    dispose(): void {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDownCapture, true);
      document.removeEventListener('keyup', onKeyUpCapture, true);
      document.removeEventListener('beforeinput', onInputCapture, true);
      document.removeEventListener('compositionstart', onInputCapture, true);
      document.removeEventListener('keydown', onKeyDownBubble);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      clearTransientFrame();
      finishWindowReturn();
    }
  };
}
