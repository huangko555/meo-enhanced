import { sourceTablePaste, sourceTableAt } from './sourceTableCommands';
import { EditorSelection, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { inputAssistanceFacet } from './typingAssistance';
import { markdownTableFromCells, parseMarkdownTable } from '../application/delimitedTable';
import { parseMeoTableClipboard, parseHtmlTableElement, parseTsvTableClipboard, meoTableClipboardMime, maxClipboardCells } from './tableClipboard';
import { clipboardHtmlToMarkdown, clipboardHtmlBlockEdges, parseClipboardHtml, safeClipboardUrl } from './htmlPaste';

// The editor owner supplies formula context; paste dispatch keeps its own
// history/input rules without depending on rendered widgets.
type MathPasteText = (view: EditorView, text: string) => string | null;

function hasInputSyntax(view: EditorView, position: number, names: RegExp): boolean {
  let node = syntaxTree(view.state).resolveInner(position, -1);
  for (;;) {
    if (names.test(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

export function isCodeInput(view: EditorView, position = view.state.selection.main.head): boolean {
  return hasInputSyntax(view, position, /^(?:FencedCode|CodeBlock|InlineCode|CodeText|CodeInfo)$/);
}

/** Shared explicit plain paste bypasses conversion while retaining the existing edit/history owner. */
export function insertPlainClipboardText(view: EditorView, text: string, mathPasteText: MathPasteText): boolean {
  const active = view.dom.ownerDocument.activeElement;
  if (active instanceof HTMLTextAreaElement && view.dom.contains(active)) {
    active.setRangeText(text.replace(/\r\n?/g, '\n'), active.selectionStart, active.selectionEnd, 'end');
    active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
  } else {
    view.dispatch(view.state.replaceSelection(mathPasteText(view, text) ?? text.replace(/\r\n?/g, '\n')), { annotations: Transaction.userEvent.of('input.paste') });
    view.focus();
  }
  return true;
}

export const pasteAssistance = (mathPasteText: MathPasteText) => EditorView.domEventHandlers({
  paste(event, view) {
    // Multiple selections use CodeMirror's literal paste distribution.
    if (!event.clipboardData || event.target instanceof HTMLTextAreaElement || view.compositionStarted || view.state.selection.ranges.length !== 1) return false;
    const clipboard = event.clipboardData;
    const preferences = view.state.facet(inputAssistanceFacet);
    const selection = view.state.selection.main;
    const mathText = mathPasteText(view, clipboard.getData('text/plain'));
    if (mathText !== null) {
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(mathText), { annotations: Transaction.userEvent.of('input.paste') });
      return true;
    }
    if ([selection.from, selection.to].some(position => isCodeInput(view, position)
      || hasInputSyntax(view, position, /^(?:HTMLBlock|HTMLTag)$/))) return false;
    const text = clipboard.getData('text/plain');
    const meoMatrix = parseMeoTableClipboard(clipboard.getData(meoTableClipboardMime));
    const htmlText = clipboard.getData('text/html');
    const html = meoMatrix ? null : parseClipboardHtml(htmlText);
    const tables = html ? Array.from(html.querySelectorAll('table')) : [];
    const tableTarget = sourceTableAt(view.state);
    // Markdown cannot represent nested tables without flattening their contents.
    if (!tableTarget && tables.some(table => table.parentElement?.closest('table'))) return false;
    // Prose owns the complete fragment; cell paste still extracts the first matrix.
    const singleTable = !tableTarget && tables.length === 1
      && !Array.from(tables[0].children).some(child => child.tagName === 'CAPTION' && clipboardHtmlToMarkdown(child))
      && !clipboardHtmlToMarkdown(html!, () => '');
    const matrix = meoMatrix
      ?? (tables.length && (tableTarget || singleTable) ? parseHtmlTableElement(tables[0], preferences.pasteHtml) : null)
      ?? (!htmlText || (html && !tables.length) || tableTarget ? parseTsvTableClipboard(text) : null);
    const markdown = tableTarget ? parseMarkdownTable(text) : null;
    const cellMatrix = matrix ?? (markdown ? { cells: markdown.cells, source: 'meo' as const } : null);
    if (cellMatrix && tableTarget) {
      const transaction = sourceTablePaste(view.state, cellMatrix);
      if (transaction) { event.preventDefault(); view.dispatch(transaction); return true; }
      event.preventDefault(); return true;
    }
    if (!preferences.convertTables && (matrix || tables.length)) return false;
    if (!meoMatrix && tables.length && (!preferences.pasteHtml && !singleTable)) return false;
    let insert: string | null = null;
    let htmlConverted = false;
    if (preferences.pasteUrl && !selection.empty && safeClipboardUrl(text)) {
      const label = view.state.sliceDoc(selection.from, selection.to).replace(/[\\\[\]]/g, '\\$&');
      insert = '[' + label + '](' + text.trim().replaceAll('(', '%28').replaceAll(')', '%29') + ')';
    } else if (preferences.convertTables) {
      if (matrix) insert = markdownTableFromCells(matrix.cells, matrix.source === 'meo');
      else if (html && tables.length && preferences.pasteHtml) {
        let cells = 0, invalid = false;
        insert = clipboardHtmlToMarkdown(html, table => {
          if (invalid) return '';
          const matrix = parseHtmlTableElement(table, true);
          if (!matrix || (cells += matrix.cells.length * matrix.cells[0].length) > maxClipboardCells) {
            invalid = true;
            return '';
          }
          return markdownTableFromCells(matrix.cells, true);
        });
        // Reject the whole conversion, so neither valid siblings nor prose are lost.
        if (invalid) return false;
        htmlConverted = true;
      }
    }
    if (insert === null && preferences.pasteHtml && html) {
      insert = clipboardHtmlToMarkdown(html);
      htmlConverted = true;
    }
    if (insert === null) return false;
    const edges = htmlConverted ? clipboardHtmlBlockEdges(html!)
      : { start: insert.startsWith('| '), end: insert.startsWith('| ') };
    const fromLine = view.state.doc.lineAt(selection.from);
    const toLine = view.state.doc.lineAt(selection.to);
    if (edges.start && selection.from > fromLine.from) insert = '\n\n' + insert;
    if (edges.end && selection.to < toLine.to) insert += '\n\n';
    event.preventDefault();
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert },
      selection: EditorSelection.cursor(selection.from + insert.length), annotations: Transaction.userEvent.of('input.paste') });
    return true;
  }
});
