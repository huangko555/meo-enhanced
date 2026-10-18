import type { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const navigationEffects = new WeakSet<StateEffect<unknown>>();

/** Keep the native scroll target while identifying our geometry-only requests
 * to presentation consumers. No dependence on CodeMirror's private effect type. */
export function editorScrollIntoView(...args: Parameters<typeof EditorView.scrollIntoView>) {
  const effect = EditorView.scrollIntoView(...args);
  navigationEffects.add(effect);
  return effect;
}

export function isEditorScrollEffect(effect: StateEffect<unknown>): boolean {
  return navigationEffects.has(effect);
}
