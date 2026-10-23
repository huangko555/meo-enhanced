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
  };
  const handleWheel = (event: WheelEvent): boolean => {
    const modifier = options.mac ? event.metaKey || event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (disposed || !options.enabled() || !modifier || event.shiftKey || event.altKey
      || !Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
    event.preventDefault(); event.stopPropagation();
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
  window.addEventListener('pagehide', flush);
  window.addEventListener('blur', flush);
  return {
    handleWheel, flush,
    dispose() {
      flush(); disposed = true;
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('blur', flush);
    }
  };
}
