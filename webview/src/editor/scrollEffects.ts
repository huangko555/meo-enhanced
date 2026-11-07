import { Annotation, type Extension, type StateEffect } from '@codemirror/state';
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

/** The native caret request is delegated to the editor's semantic reveal. */
export const editorManagedScroll = Annotation.define<boolean>();

/** Follow the lifetime of CodeMirror's pending scroll request, rather than a
 * microtask or frame timeout. A newer native or explicit request replaces it. */
export function createEditorScrollOwnership(): Extension {
  let delegated = false;
  return [
    EditorView.updateListener.of(update => {
      for (const transaction of update.transactions) {
        if (transaction.scrollIntoView) delegated = transaction.isUserEvent('undo') || transaction.isUserEvent('redo')
          || transaction.annotation(editorManagedScroll) === true;
        if (transaction.effects.some(isEditorScrollEffect)) delegated = false;
      }
    }),
    EditorView.scrollHandler.of(() => {
      const handled = delegated;
      delegated = false;
      return handled;
    })
  ];
}
