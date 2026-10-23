const pointerFocus = new WeakMap<HTMLElement, AbortController>();
const actionGroups = '.meo-preview-code-actions, .meo-code-block-actions, .meo-mermaid-toolbar, .meo-math-copy-actions, .meo-mermaid-preview-controls, .meo-mermaid-fullscreen-controls';

/** Restore logical focus without presenting a mouse action as keyboard navigation. */
export function focusRenderedBlockAction(target: HTMLElement, pointerDriven: boolean): void {
  pointerFocus.get(target)?.abort();
  target.removeAttribute('data-meo-pointer-focus');
  if (pointerDriven && target.matches('button, [role="button"]')) {
    const events = new target.ownerDocument.defaultView!.AbortController();
    pointerFocus.set(target, events);
    target.dataset.meoPointerFocus = 'true';
    const clear = () => {
      events.abort(); pointerFocus.delete(target); target.removeAttribute('data-meo-pointer-focus');
    };
    target.addEventListener('blur', clear, { signal: events.signal });
    target.addEventListener('keydown', clear, { signal: events.signal });
  } else pointerFocus.delete(target);
  target.focus({ preventScroll: true });
}

/** A mouse action can leave an earlier keyboard-focused button logically focused. */
export function suppressRenderedBlockPointerFocus(root: HTMLElement): void {
  const active = root.ownerDocument.activeElement as HTMLElement | null;
  if (active && root.contains(active) && active.closest(actionGroups)) focusRenderedBlockAction(active, true);
}
