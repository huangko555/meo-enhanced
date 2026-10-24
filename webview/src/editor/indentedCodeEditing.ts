import { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { getCodeContainerColumns, getIndentedCodeLinePrefix, indentedCodeBlockAt, parseBlockLinePrefix } from './codeBlockSource';

/** Continue literal indentation; an empty code row exits only the code layer. */
export function insertIndentedCodeNewline(view: EditorView, tree: Tree, exitOnEmpty = true): boolean {
  const { state } = view;
  if (state.readOnly || view.composing) return false;
  const contexts = state.selection.ranges.map(range => {
    const node = indentedCodeBlockAt(state, range.from, tree);
    if (!node || state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number) return null;
    const line = state.doc.lineAt(range.from);
    const offset = getIndentedCodeLinePrefix(state, node, line).length;
    const prefix = { ...parseBlockLinePrefix(line.text.slice(0, offset), state.tabSize), content: line.text.slice(offset) };
    if (range.from < line.from + prefix.prefix.length) return null;
    return { line, prefix, containerColumns: getCodeContainerColumns(state, node, line) };
  });
  if (contexts.some(context => !context)) return false;
  let index = 0;
  view.dispatch(state.changeByRange(range => {
    const { line, prefix, containerColumns } = contexts[index++]!;
    if (exitOnEmpty && !prefix.content && range.empty) {
      // A tab can cross the container/code boundary. Retain only its container
      // columns rather than accidentally leaving another code indentation.
      let columns = 0, container = '';
      for (const character of prefix.prefix) {
        if (columns >= containerColumns) break;
        const width = character === '\t' ? state.tabSize - columns % state.tabSize : 1;
        container += columns + width <= containerColumns ? character : ' '.repeat(containerColumns - columns);
        columns += width;
      }
      const insert = line.text === container ? '\n' + container : container;
      return { changes: { from: line.from, to: line.to, insert },
        range: EditorSelection.cursor(line.from + insert.length) };
    }
    const insert = '\n' + prefix.prefix;
    return { changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length) };
  }), { annotations: Transaction.userEvent.of('input') });
  return true;
}
