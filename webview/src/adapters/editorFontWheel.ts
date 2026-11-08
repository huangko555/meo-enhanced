import { normalizeEditorFontSize, type EditorFontSizePreference } from '../../../src/foundation/editorFontSize';

/** One gesture owner for editor content and the Preview iframe. */
export function createEditorFontWheel(options: {
  readonly mac: boolean;
  enabled(): boolean;
  getPreference(): EditorFontSizePreference;
  getAutomaticSize(): number;
  apply(preference: EditorFontSizePreference): void;
  save(): void;
}) {
  let frame: number | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let steps = 0;
  let fineDelta = 0;
  let lastEvent = 0;
  let dirty = false;
  let disposed = false;
  let modifierHeld = false;
  let wheelGesture = false;
  const bindings = new Set<{ refresh(): void; dispose(): void }>();
  const handled = new WeakSet<WheelEvent>();
  const hasModifier = (event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>) =>
    (options.mac ? event.metaKey || event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.shiftKey && !event.altKey;
  const refresh = () => { for (const binding of bindings) binding.refresh(); };
  const apply = () => {
    frame = undefined;
    const delta = steps; steps = 0;
    if (!delta) return;
    const preference = options.getPreference();
    const base = preference.mode === 'auto' ? options.getAutomaticSize() : preference.value;
    const value = normalizeEditorFontSize(base + delta);
    // Auto can inherit a VS Code size outside the custom range. A boundary
    // must never turn a zoom-in into a shrink (or a zoom-out into growth).
    if (delta > 0 ? value <= base : value >= base) return;
    options.apply({ mode: 'custom', value });
    dirty = true;
  };
  const flush = () => {
    if (frame !== undefined) { cancelAnimationFrame(frame); apply(); }
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (dirty) { dirty = false; options.save(); }
    fineDelta = 0;
    wheelGesture = false;
    refresh();
  };
  const handleWheel = (event: WheelEvent, cancelDefault = true): boolean => {
    if (disposed || handled.has(event) || !options.enabled() || !hasModifier(event)
      || !Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
    handled.add(event);
    if (cancelDefault && event.cancelable) event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastEvent > 200 || Math.sign(fineDelta) !== Math.sign(event.deltaY)) fineDelta = 0;
    lastEvent = now;
    // Mouse notches arrive as lines or coarse pixel deltas. Accumulate fine
    // trackpad events instead of changing a full pixel for every tiny event.
    if (event.deltaMode !== 0 || Math.abs(event.deltaY) >= 40) {
      steps -= Math.sign(event.deltaY);
      fineDelta = 0;
    } else {
      fineDelta += event.deltaY;
      const amount = Math.trunc(fineDelta / 40);
      steps -= amount;
      fineDelta -= amount * 40;
    }
    if (steps && frame === undefined) frame = requestAnimationFrame(apply);
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 200);
    return true;
  };
  const reset = () => { modifierHeld = false; flush(); };
  const bind = (document: Document, {
    signal, accepts = () => true, capture = true
  }: { signal?: AbortSignal; accepts?: (event: WheelEvent) => boolean; capture?: boolean } = {}): void => {
    if (disposed || signal?.aborted) return;
    let blocking = false;
    const onWheel = (event: WheelEvent) => { if ((capture || !event.defaultPrevented) && accepts(event)) handleWheel(event); };
    const observeWheel = (event: WheelEvent) => {
      if (!hasModifier(event)) {
        modifierHeld = false; wheelGesture = false; refresh();
      } else if (!blocking && (capture || !event.defaultPrevented) && accepts(event) && options.enabled()) {
        // Pinch/remote modifier wheels can arrive without a preceding keydown.
        // Chromium makes the first event on a passive surface non-cancelable;
        // apply its font delta once, then own the rest of that gesture.
        if (handleWheel(event, false)) { wheelGesture = true; refresh(); }
      }
    };
    const observeModifier = (event: KeyboardEvent | PointerEvent) => {
      modifierHeld = hasModifier(event); wheelGesture = false; refresh();
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') reset(); };
    const onBlur = () => reset();
    const binding = {
      refresh() {
        const next = !disposed && options.enabled() && (modifierHeld || wheelGesture);
        if (next === blocking) return;
        blocking = next;
        if (blocking) document.addEventListener('wheel', onWheel, { capture, passive: false });
        else document.removeEventListener('wheel', onWheel, capture);
      },
      dispose() {
        bindings.delete(binding);
        document.removeEventListener('wheel', onWheel, capture);
        document.removeEventListener('wheel', observeWheel, capture);
        document.removeEventListener('keydown', observeModifier, true);
        document.removeEventListener('keyup', observeModifier, true);
        document.removeEventListener('pointerover', observeModifier, true);
        document.removeEventListener('pointermove', observeModifier, true);
        document.removeEventListener('visibilitychange', onVisibility);
        document.defaultView?.removeEventListener('blur', onBlur);
        document.defaultView?.removeEventListener('pagehide', onBlur);
        signal?.removeEventListener('abort', binding.dispose);
      }
    };
    bindings.add(binding);
    document.addEventListener('wheel', observeWheel, { capture, passive: true });
    document.addEventListener('keydown', observeModifier, { capture: true, passive: true });
    document.addEventListener('keyup', observeModifier, { capture: true, passive: true });
    document.addEventListener('pointerover', observeModifier, { capture: true, passive: true });
    document.addEventListener('pointermove', observeModifier, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    document.defaultView?.addEventListener('blur', onBlur);
    document.defaultView?.addEventListener('pagehide', onBlur);
    signal?.addEventListener('abort', binding.dispose, { once: true });
    binding.refresh();
  };
  return {
    bind, refresh, flush,
    dispose() {
      flush(); disposed = true;
      for (const binding of [...bindings]) binding.dispose();
    }
  };
}
