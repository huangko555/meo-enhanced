import type { EditorView } from '@codemirror/view';

/**
 * Commit a layout mutation before paint. Call after an editor transaction or
 * from a size observer, never during a StateField/ViewPlugin update. Most work
 * should use requestMeasure; a resize delivered after frame callbacks needs
 * this synchronous completion to avoid one frame of stale gutter geometry.
 * Keep the pinned CodeMirror 6.43.15 implementation dependency at this one
 * adapter; upgrades must pass the passive layout and painted-frame contracts.
 */
export function flushEditorLayout(view: EditorView): void {
  view.requestMeasure();
  (view as EditorView & { measure(flush?: boolean): void }).measure(false);
}

const pendingSizeMeasurements = new WeakSet<EditorView>();

/** Coalesce size observers for the same editor, including independent blocks. */
export function commitObservedEditorSize(view: EditorView): void {
  if (pendingSizeMeasurements.has(view)) return;
  pendingSizeMeasurements.add(view);
  queueMicrotask(() => {
    pendingSizeMeasurements.delete(view);
    if (view.dom.isConnected) flushEditorLayout(view);
  });
}
