type FocusableEditor = {
  readonly view: { readonly dom: HTMLElement };
  hasFocus(): boolean;
  focus(): void;
  retainViewportOnWindowReturn(isCurrent: () => boolean): () => void;
};

export type EditorFocusController = {
  /**
   * Register chrome inputs only; unregister on removal (or dispose with the Webview).
   * The editor retains ownership of its internal inputs and document selection.
   */
  registerInput(input: HTMLInputElement | HTMLTextAreaElement): () => void;
  /** Only an editor return needs the caller's editor surface refresh. */
  restoreFromHost(): 'editor' | 'input' | false;
  dispose(): void;
};

type NativeInput = HTMLInputElement | HTMLTextAreaElement;
type InputSelection = {
  value: string;
  start: number | null;
  end: number | null;
  direction: 'forward' | 'backward' | 'none' | null;
  scrollLeft: number;
  scrollTop: number;
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
  const inputs = new Map<NativeInput, InputSelection>();
  let lastFocusedInput: NativeInput | null = null;
  let windowReturnInput: { target: NativeInput; selection: InputSelection } | null = null;
  let paintInput: NativeInput | null = null;
  let restoringInput = false;
  let releaseWindowReturnViewport: (() => void) | null = null;

  const registeredInput = (target: EventTarget | null): NativeInput | null => (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && inputs.has(target) ? target : null
  );
  const captureInput = (input: NativeInput, leaving = false): InputSelection => {
    const previous = inputs.get(input);
    // Chromium resets an input's horizontal scroll before dispatching focusout.
    // Keep the scroll observed while focused, alongside the final native range.
    const scroll = leaving && previous?.value === input.value ? previous : input;
    const selection = {
      value: input.value, start: input.selectionStart, end: input.selectionEnd,
      direction: input.selectionDirection, scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop
    };
    inputs.set(input, selection);
    return selection;
  };
  const activeModal = (): Element | undefined => (
    [...document.querySelectorAll('dialog:modal, [aria-modal="true"]')].find(node => node.getClientRects().length > 0)
  );
  const inputAvailable = (input: NativeInput): boolean => {
    const modal = activeModal();
    return inputs.has(input) && input.isConnected && !input.disabled && !input.readOnly
      && !input.closest('[hidden], [inert]') && input.getClientRects().length > 0
      && getComputedStyle(input).visibility === 'visible' && (!modal || modal.contains(input));
  };
  const restoreInputSelection = (input: NativeInput, selection: InputSelection): void => {
    // A clear, replacement or other value update owns its new native selection.
    // Window return restores interaction state, never an earlier input value.
    if (input.value !== selection.value) return;
    if (selection.start !== null && selection.end !== null) input.setSelectionRange(selection.start, selection.end, selection.direction ?? 'none');
    input.scrollLeft = selection.scrollLeft;
    input.scrollTop = selection.scrollTop;
  };

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
      if (!transientOrigin || !isEditableMode() || documentPointerGeneration !== pointerGeneration || windowReturnPending || activeModal()) return;
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
    releaseWindowReturnViewport?.();
    releaseWindowReturnViewport = null;
    windowReturnPending = false;
    restoreOnWindowReturn = false;
    windowReturnInput = null;
    paintInput?.classList.remove('meo-input-focus-return-pending');
    paintInput = null;
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
  const restoreWindowReturn = (): 'editor' | 'input' | false => {
    // Host activation alone cannot grant keyboard focus from another Webview.
    if (!document.hasFocus()) return false;
    const active = document.activeElement;
    const input = registeredInput(active);
    if (input && inputAvailable(input)) {
      if (windowReturnInput?.target === input && documentPointerGeneration === windowReturnPointerGeneration) {
        restoreInputSelection(input, windowReturnInput.selection);
        windowReturnInput = null;
      }
      settleWindowReturnBeforePaint();
      return 'input';
    }
    if (!isEditableMode() && !windowReturnInput) {
      finishWindowReturn();
      return false;
    }
    if (inEditor(active)) {
      // Native activation or a new click already owns this selection. A late
      // Host notification must not reapply the target saved before blur.
      settleWindowReturnBeforePaint();
      return isEditableMode() ? 'editor' : false;
    }
    if (active !== document.body && active !== document.documentElement) return false;
    if (documentPointerGeneration !== windowReturnPointerGeneration) return false;
    const inputReturn = windowReturnInput;
    if (inputReturn && inputAvailable(inputReturn.target)) {
      restoringInput = true;
      try {
        inputReturn.target.focus({ preventScroll: true });
        restoreInputSelection(inputReturn.target, inputReturn.selection);
      } finally {
        restoringInput = false;
      }
      windowReturnInput = null;
      settleWindowReturnBeforePaint();
      return 'input';
    }
    // Closing or removing an input may fall back to the editable document,
    // but never through a modal or into the hidden editor in Preview.
    if (!isEditableMode() || activeModal()) {
      finishWindowReturn();
      return false;
    }
    const editor = getEditor();
    if (!editor) return false;
    // Input must be connected synchronously. Only painting waits for the
    // activation click's native selection to finish, never the first key.
    editor.focus();
    settleWindowReturnBeforePaint();
    return 'editor';
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (inEditor(target)) {
      lastFocusedInput = null;
      windowReturnInput = null;
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
    lastFocusedInput = registeredInput(target);
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
      lastFocusedInput = null;
      windowReturnInput = null;
      editorWasLastFocused = true;
      transientOrigin = false;
      clearTransientFrame();
      restoreOnWindowReturn = false;
      settleWindowReturnBeforePaint();
      return;
    }
    const input = registeredInput(event.target);
    lastFocusedInput = input;
    editorWasLastFocused = false;
    if (input && (restoringInput || (windowReturnPending && windowReturnInput?.target === input))) {
      if (!restoringInput) restoreWindowReturn();
      return;
    }
    windowReturnPointerGeneration = null;
    finishWindowReturn();
    if (input) captureInput(input);
    const target = event.target;
    if (target instanceof Element && root.contains(target) && isFocusTaking(target)) {
      if (inEditor(event.relatedTarget)) transientOrigin = true;
    }
  };
  const onFocusOut = (event: FocusEvent): void => {
    const input = registeredInput(event.target);
    if (input) captureInput(input, true);
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
    if (inEditor(event.target) || registeredInput(event.target)) {
      finishWindowReturn();
    } else if (restoreWindowReturn()) {
      finishWindowReturn();
    }
  };
  const onInputStateChange = (event: Event): void => {
    const input = registeredInput(event.target);
    if (input && document.hasFocus() && document.activeElement === input) captureInput(input);
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
    releaseWindowReturnViewport?.();
    releaseWindowReturnViewport = null;
    const input = registeredInput(document.activeElement) ?? lastFocusedInput;
    const inputSelection = input && inputAvailable(input)
      ? (document.activeElement === input ? captureInput(input, true) : inputs.get(input)) : null;
    paintInput?.classList.remove('meo-input-focus-return-pending');
    windowReturnInput = input && inputSelection ? { target: input, selection: inputSelection } : null;
    paintInput = windowReturnInput?.target ?? null;
    paintInput?.classList.add('meo-input-focus-return-pending');
    restoreOnWindowReturn = windowReturnInput !== null || getEditor()?.hasFocus() === true || editorWasLastFocused;
    windowReturnGeneration += 1;
    clearWindowReturnPaint();
    clearTransientFrame();
    windowReturnPending = restoreOnWindowReturn;
    windowReturnPointerGeneration = restoreOnWindowReturn ? documentPointerGeneration : null;
    if (windowReturnPending && !windowReturnInput && isEditableMode()) {
      releaseWindowReturnViewport = getEditor()?.retainViewportOnWindowReturn(() => (
        windowReturnPending && document.hasFocus() && inEditor(document.activeElement)
        && documentPointerGeneration === windowReturnPointerGeneration
      )) ?? null;
    }
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
  document.addEventListener('input', onInputStateChange, true);
  document.addEventListener('selectionchange', onInputStateChange, true);
  document.addEventListener('scroll', onInputStateChange, true);
  document.addEventListener('keydown', onKeyDownBubble);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);

  return {
    registerInput(input): () => void {
      captureInput(input);
      return () => {
        inputs.delete(input);
        if (lastFocusedInput === input) lastFocusedInput = null;
        if (windowReturnInput?.target === input) windowReturnInput = null;
        if (paintInput === input) {
          input.classList.remove('meo-input-focus-return-pending');
          paintInput = null;
        }
      };
    },
    restoreFromHost(): 'editor' | 'input' | false {
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
      document.removeEventListener('input', onInputStateChange, true);
      document.removeEventListener('selectionchange', onInputStateChange, true);
      document.removeEventListener('scroll', onInputStateChange, true);
      document.removeEventListener('keydown', onKeyDownBubble);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      clearTransientFrame();
      finishWindowReturn();
      inputs.clear();
      lastFocusedInput = null;
    }
  };
}
