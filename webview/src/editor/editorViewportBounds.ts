import type { EditorView } from '@codemirror/view';

/** Visible document bounds after passive document chrome covers the top edge. */
export function editorViewportBounds(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect();
  const inset = Number(view.scrollDOM.dataset?.meoBlockHeaderInset ?? 0);
  const top = rect.top + (Number.isFinite(inset) ? Math.max(0, inset) : 0);
  return { top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: Math.max(0, rect.bottom - top) };
}
