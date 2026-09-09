import { Facet, type EditorState, type Extension, type StateEffect } from '@codemirror/state';

/** Semantic table target stored with the document transaction that created its history event. */
export type TableHistoryFocusTarget = {
  /** Position of the table start in the document after the same transaction. */
  readonly tableFrom: number;
  readonly row: number;
  readonly col: number;
  readonly caret: number;
};

export type CodeMirrorTableHistoryFocus = {
  readonly extension: Extension;
  effect(target: TableHistoryFocusTarget): StateEffect<unknown>;
  read(state: EditorState): TableHistoryFocusTarget | null;
};

export const tableHistoryFocusFacet = Facet.define<
  CodeMirrorTableHistoryFocus,
  CodeMirrorTableHistoryFocus | undefined
>({
  combine(values) {
    if (values.length > 1) throw new Error('Only one table history focus Adapter may be installed');
    return values[0];
  }
});

export function getTableHistoryFocus(state: EditorState): CodeMirrorTableHistoryFocus {
  const adapter = state.facet(tableHistoryFocusFacet);
  if (!adapter) throw new Error('CodeMirror table history focus Adapter is not installed');
  return adapter;
}
