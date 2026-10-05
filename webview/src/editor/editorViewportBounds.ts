import { EditorView } from '@codemirror/view';

/** Visible document bounds after passive document chrome covers the top edge. */
export function editorViewportBounds(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect();
  // CodeMirror already reserves pending chrome before a reveal mounts it.
  // Use the same reservation while input temporarily replaces the header DOM.
  const reservedTop = Math.max(0, ...(view.state?.facet?.(EditorView.scrollMargins) ?? [])
    .map((readMargin) => readMargin(view)?.top ?? 0));
  const inset = Math.max(reservedTop, Number(view.scrollDOM.dataset?.meoBlockHeaderInset ?? 0));
  const top = rect.top + (Number.isFinite(inset) ? Math.max(0, inset) : 0);
  return { top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: Math.max(0, rect.bottom - top) };
}
