import type { EditorView } from '@codemirror/view';

/** Resolve observers that only need a source line without flushing layout for
 * an exact character hit. Nested editors retain their own coordinate owner. */
export function sourceLinePositionAtTarget(view: EditorView, target: EventTarget | null): number | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const line = element?.closest<HTMLElement>('.cm-line');
  if (!line || !element || !view.contentDOM.contains(line) || line.closest('.cm-editor') !== view.dom) return null;
  try {
    return view.state.doc.lineAt(view.posAtDOM(element, 0)).from;
  } catch {
    return null;
  }
}
