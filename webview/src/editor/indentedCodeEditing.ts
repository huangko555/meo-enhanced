import { EditorSelection, Transaction, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { getCodeContainerColumns, getIndentedCodeLinePrefix, indentedCodeBlockAt, parseBlockLinePrefix } from './codeBlockSource';

/** Markdown source continues existing whitespace, not the embedded language's
 * bracket/tag indentation. Literal block owners can also retain their container. */
export function insertLiteralSourceNewline(view: EditorView, containerPrefix?: string, rememberContinuation = true): boolean {
  const { state } = view;
  if (state.readOnly || view.composing) return false;
  const prefix = containerPrefix ?? '';
  let continuation = '';
  const transaction = state.update(state.changeByRange(range => {
    const before = state.doc.sliceString(state.doc.lineAt(range.from).from, range.from);
    const payload = before.startsWith(prefix) ? before.slice(prefix.length) : before;
    continuation = prefix + /^[ \t]*/.exec(payload)![0];
    const insert = '\n' + continuation;
    return { changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length) };
  }), { annotations: Transaction.userEvent.of('input'), scrollIntoView: true });
  view.dispatch(transaction);
  if (rememberContinuation && containerPrefix !== undefined && state.selection.ranges.length === 1) {
    literalContinuations.set(transaction.newDoc, { head: transaction.newSelection.main.head, prefix: continuation });
  }
  return true;
}

// A known block's newline can precede its worker parse. The continuation is
// valid only for that exact immutable output and caret. Another edit or caret
// location cannot use it; weak keys retain no document, history or editor.
const literalContinuations = new WeakMap<Text, { head: number; prefix: string }>();

export function continueLiteralSourceNewline(view: EditorView): boolean {
  const { state } = view, selection = state.selection.main;
  if (state.selection.ranges.length !== 1 || !selection.empty) return false;
  const continuation = literalContinuations.get(state.doc);
  return continuation?.head === selection.head
    ? insertLiteralSourceNewline(view, continuation.prefix) : false;
}

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
