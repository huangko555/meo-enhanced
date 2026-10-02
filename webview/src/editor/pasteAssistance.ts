import { sourceTablePaste, sourceTableAt } from './sourceTableCommands';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { inputAssistanceFacet } from './typingAssistance';
import { markdownTableFromCells, parseMarkdownTable } from '../application/delimitedTable';
import { parseMeoTableClipboard, parseHtmlTableClipboard, parseTsvTableClipboard, meoTableClipboardMime } from './tableClipboard';
import { clipboardHtmlToMarkdown, safeClipboardUrl } from './htmlPaste';

export function isCodeInput(view: EditorView, position = view.state.selection.main.head): boolean {
  let node = syntaxTree(view.state).resolveInner(position, -1);
  for (;;) {
    if (/^(?:FencedCode|CodeBlock|InlineCode|CodeText|CodeInfo)$/.test(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

/** Shared explicit plain paste bypasses conversion while retaining the existing edit/history owner. */
export function insertPlainClipboardText(view: EditorView, text: string): boolean {
  const active = view.dom.ownerDocument.activeElement;
  if (active instanceof HTMLTextAreaElement && view.dom.contains(active)) {
    active.setRangeText(text.replace(/\r\n?/g, '\n'), active.selectionStart, active.selectionEnd, 'end');
    active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
  } else {
    view.dispatch(view.state.replaceSelection(text.replace(/\r\n?/g, '\n')), { annotations: Transaction.userEvent.of('input.paste') });
    view.focus();
  }
  return true;
}

export const pasteAssistance = EditorView.domEventHandlers({
  paste(event, view) {
    // Multiple selections use CodeMirror's literal paste distribution.
    if (!event.clipboardData || event.target instanceof HTMLTextAreaElement || view.compositionStarted || view.state.selection.ranges.length !== 1) return false;
    const clipboard = event.clipboardData;
    const preferences = view.state.facet(inputAssistanceFacet);
    const selection = view.state.selection.main;
    if (isCodeInput(view, selection.from) || isCodeInput(view, selection.to)) return false;
    const text = clipboard.getData('text/plain');
    const matrix = parseMeoTableClipboard(clipboard.getData(meoTableClipboardMime))
      ?? parseHtmlTableClipboard(clipboard.getData('text/html'), preferences.pasteHtml) ?? parseTsvTableClipboard(text);
    const markdown = sourceTableAt(view.state) ? parseMarkdownTable(text) : null;
    const cellMatrix = matrix ?? (markdown ? { cells: markdown.cells, source: 'meo' as const } : null);
    if (cellMatrix && sourceTableAt(view.state)) {
      const transaction = sourceTablePaste(view.state, cellMatrix);
      if (transaction) { event.preventDefault(); view.dispatch(transaction); return true; }
      event.preventDefault(); return true;
    }
    if (matrix && !preferences.convertTables) return false;
    let insert: string | null = null;
    if (preferences.pasteUrl && !selection.empty && safeClipboardUrl(text)) {
      const label = view.state.sliceDoc(selection.from, selection.to).replace(/[\\\[\]]/g, '\\$&');
      insert = '[' + label + '](' + text.trim().replaceAll('(', '%28').replaceAll(')', '%29') + ')';
    } else if (preferences.convertTables) {
      if (matrix) insert = markdownTableFromCells(matrix.cells, matrix.source === 'meo');
    }
    if (insert === null && preferences.pasteHtml) insert = clipboardHtmlToMarkdown(clipboard.getData('text/html'));
    if (insert === null) return false;
    // A table is a block even when pasted halfway through a paragraph.
    if (insert.startsWith('| ')) {
      const fromLine = view.state.doc.lineAt(selection.from);
      const toLine = view.state.doc.lineAt(selection.to);
      if (selection.from > fromLine.from) insert = '\n\n' + insert;
      if (selection.to < toLine.to) insert += '\n\n';
    }
    event.preventDefault();
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert },
      selection: EditorSelection.cursor(selection.from + insert.length), annotations: Transaction.userEvent.of('input.paste') });
    return true;
  }
});
