import { sourceTablePaste, sourceTableAt } from './sourceTableCommands';
import { EditorSelection, Transaction, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type MarkdownIt from 'markdown-it';
import type { InputAssistance } from '../../../src/foundation/editingPreferences';
import { getIndentedCodeLinePrefix, indentedCodeBlockAt } from './codeBlockSource';
import { inputAssistanceFacet } from './typingAssistance';
import { markdownTableFromCells, parseMarkdownTable } from '../application/delimitedTable';
import { parseMeoTableClipboard, parseHtmlTableElement, parseTsvTableClipboard, meoTableClipboardMime, maxClipboardCells } from './tableClipboard';
import { clipboardHtmlToMarkdown, clipboardHtmlBlockEdges, parseClipboardHtml, safeClipboardUrl } from './htmlPaste';
import { clipboardHtmlText, clipboardMarkdownText, clipboardTableText } from './clipboardPlainText';
import { pasteOptionsMenu } from './pasteOptionsMenu';

// The editor owner supplies formula context; paste dispatch keeps its own
// history/input rules without depending on rendered widgets.
type MathPasteText = (view: EditorView, text: string) => string | null;
type LinkTarget = (state: EditorState, link: SyntaxNode) => string;

function hasInputSyntax(view: EditorView, position: number, names: RegExp): boolean {
  let node = syntaxTree(view.state).resolveInner(position, -1);
  for (;;) {
    if (names.test(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

/** Bracketed text without a destination or reference label is ordinary prose. */
function enclosingLink(view: EditorView, position: number, linkTarget: LinkTarget): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(position, -1); node; node = node.parent) {
    if (node.from >= position || position >= node.to) continue;
    if (node.name === 'Autolink' || node.name === 'LinkReference'
      || (node.name === 'Link' || node.name === 'Image')
        && (node.getChild('LinkLabel') || node.getChildren('LinkMark').length > 2
          || linkTarget(view.state, node))) return node;
  }
  return null;
}

function urlInLink(view: EditorView, link: SyntaxNode, from: number, to: number, url: string): string {
  if (link.name !== 'Link' && link.name !== 'Image') return url;
  const state = view.state;
  const marks = link.getChildren('LinkMark');
  const labelClose = marks[1];
  if (labelClose && from > link.from && to <= labelClose.from) return url.replace(/[\\[\]]/g, '\\$&');
  const opening = marks.find(mark => state.sliceDoc(mark.from, mark.to) === '(');
  if (!opening) return url;
  const destination = link.getChild('URL');
  const start = destination?.from ?? opening.to;
  const end = destination?.to ?? start;
  if (from < start || to > end) return url;
  const target = url.replaceAll('<', '%3C').replaceAll('>', '%3E');
  if (destination && state.sliceDoc(start, start + 1) === '<') {
    return from === to ? target : (from === start ? '<' : '') + target + (to === end ? '>' : '');
  }
  let balance = 0;
  for (const character of url) {
    if (character === '(') balance++;
    if (character === ')' && --balance < 0) break;
  }
  if (balance === 0) return target;
  // An angle-delimited destination keeps literal parentheses in a whole URL.
  if (from === start && to === end) return '<' + target + '>';
  return target.replaceAll('(', '%28').replaceAll(')', '%29');
}

export function isCodeInput(view: EditorView, position = view.state.selection.main.head): boolean {
  return hasInputSyntax(view, position, /^(?:FencedCode|CodeBlock|InlineCode|CodeText|CodeInfo)$/)
    || indentedCodeBlockAt(view.state, position) !== null;
}

function indentedCodePasteText(view: EditorView, text: string): string | null {
  if (view.state.selection.ranges.length !== 1 || !/[\r\n]/.test(text)) return null;
  const { state } = view, selection = state.selection.main;
  const node = indentedCodeBlockAt(state, selection.from);
  if (!node || indentedCodeBlockAt(state, selection.to)?.from !== node.from) return null;
  const prefix = getIndentedCodeLinePrefix(state, node, state.doc.lineAt(selection.from));
  if (selection.from < state.doc.lineAt(selection.from).from + prefix.length) return null;
  return text.replace(/\r\n?/g, '\n').replaceAll('\n', '\n' + prefix);
}

/** Shared explicit plain paste bypasses conversion while retaining the existing edit/history owner. */
export function insertPlainClipboardText(view: EditorView, text: string, mathPasteText: MathPasteText): boolean {
  const active = view.dom.ownerDocument.activeElement;
  if (active instanceof HTMLTextAreaElement && view.dom.contains(active)) {
    active.setRangeText(text.replace(/\r\n?/g, '\n'), active.selectionStart, active.selectionEnd, 'end');
    active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
  } else {
    view.dispatch(view.state.replaceSelection(mathPasteText(view, text) ?? indentedCodePasteText(view, text) ?? text.replace(/\r\n?/g, '\n')), { annotations: Transaction.userEvent.of('input.paste') });
    view.focus();
  }
  return true;
}

// Choosing another representation is optional. Keep its additional parsing
// bounded independently of the limits on regular clipboard conversion.
const maxPasteOptionsCharacters = 128 * 1024;
type PasteDefaults = Pick<InputAssistance, 'convertTables' | 'pasteHtml' | 'pasteUrl'>;

export const pasteAssistance = (
  mathPasteText: MathPasteText, markdown: MarkdownIt, captureScrollCurrentness: () => () => boolean, linkTarget: LinkTarget
) => [pasteOptionsMenu, EditorView.domEventHandlers({
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
    const codeText = indentedCodePasteText(view, clipboard.getData('text/plain'));
    if (codeText !== null) {
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(codeText), { annotations: Transaction.userEvent.of('input.paste') });
      return true;
    }
    if ([selection.from, selection.to].some(position => isCodeInput(view, position)
      || hasInputSyntax(view, position, /^(?:HTMLBlock|HTMLTag)$/))) return false;
    const text = clipboard.getData('text/plain');
    const meoText = clipboard.getData(meoTableClipboardMime);
    const meoMatrix = parseMeoTableClipboard(meoText);
    const htmlText = clipboard.getData('text/html');
    const html = meoMatrix ? null : parseClipboardHtml(htmlText);
    const tables = html ? Array.from(html.querySelectorAll('table')) : [];
    const tableTarget = sourceTableAt(view.state);
    // Markdown cannot represent nested tables without flattening their contents.
    const nestedTable = !tableTarget && tables.some(table => table.parentElement?.closest('table'));
    // Prose owns the complete fragment; cell paste still extracts the first matrix.
    const singleTable = !tableTarget && !nestedTable && tables.length === 1
      && !Array.from(tables[0].children).some(child => child.tagName === 'CAPTION' && clipboardHtmlToMarkdown(child))
      && !clipboardHtmlToMarkdown(html!, () => '');
    let tsvMatrix: ReturnType<typeof parseTsvTableClipboard> | undefined;
    const readTsv = () => {
      if (tsvMatrix === undefined) {
        tsvMatrix = !htmlText || (html && !tables.length) || tableTarget ? parseTsvTableClipboard(text) : null;
      }
      return tsvMatrix;
    };
    const readMatrix = (keepFormatting: boolean) => meoMatrix
      ?? (tables.length && (tableTarget || singleTable) ? parseHtmlTableElement(tables[0], keepFormatting) : null)
      ?? readTsv();
    const matrix = readMatrix(preferences.pasteHtml);
    if (tableTarget) {
      const markdown = !matrix ? parseMarkdownTable(text) : null;
      const cellMatrix = matrix ?? (markdown ? { cells: markdown.cells, source: 'meo' as const } : null);
      if (cellMatrix) {
        const transaction = sourceTablePaste(view.state, cellMatrix);
        if (transaction) view.dispatch(transaction);
        event.preventDefault();
        return true;
      }
    }

    const url = safeClipboardUrl(text);
    const fromLink = url ? enclosingLink(view, selection.from, linkTarget) : null;
    const link = fromLink ?? (url && selection.to !== selection.from ? enclosingLink(view, selection.to, linkTarget) : null);
    // A shortcut reference uses its visible label as its destination key.
    // Make that destination explicit before replacing any part of the label.
    if (url && fromLink && (fromLink.name === 'Link' || fromLink.name === 'Image') && !fromLink.getChild('LinkLabel')) {
      const marks = fromLink.getChildren('LinkMark');
      const closing = marks.length === 2 ? marks[1] : undefined;
      if (closing && selection.from >= marks[0]!.to && selection.to <= closing.from) {
        const label = view.state.sliceDoc(marks[0]!.to, closing.from);
        const pasted = urlInLink(view, fromLink, selection.from, selection.to, url);
        const remaining = view.state.sliceDoc(selection.to, fromLink.to);
        event.preventDefault();
        view.dispatch({
          changes: { from: selection.from, to: fromLink.to, insert: pasted + remaining + '[' + label + ']' },
          selection: EditorSelection.cursor(selection.from + pasted.length),
          annotations: Transaction.userEvent.of('input.paste'),
          scrollIntoView: true
        });
        return true;
      }
    }
    const convertedText = (defaults: PasteDefaults, matrix: ReturnType<typeof readMatrix>): string | null => {
      if (nestedTable || (!defaults.convertTables && (matrix || tables.length))
        || (!meoMatrix && tables.length && !defaults.pasteHtml && !singleTable)) return null;
      let insert: string | null = null;
      let htmlConverted = false;
      if (url && link) {
        insert = urlInLink(view, link, selection.from, selection.to, url);
      } else if (defaults.pasteUrl && !selection.empty && url) {
        const label = view.state.sliceDoc(selection.from, selection.to).replace(/[\\\[\]]/g, '\\$&');
        insert = '[' + label + '](' + url.replaceAll('(', '%28').replaceAll(')', '%29') + ')';
      } else if (defaults.convertTables) {
        if (matrix) insert = markdownTableFromCells(matrix.cells, matrix.source === 'meo');
        else if (html && tables.length && defaults.pasteHtml) {
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
          // Reject the whole conversion, so valid siblings and prose are retained.
          if (invalid) return null;
          htmlConverted = true;
        }
      }
      if (insert === null && defaults.pasteHtml && html) {
        insert = clipboardHtmlToMarkdown(html);
        htmlConverted = true;
      }
      if (insert === null) return null;
      const edges = htmlConverted ? clipboardHtmlBlockEdges(html!)
        : { start: insert.startsWith('| '), end: insert.startsWith('| ') };
      const fromLine = view.state.doc.lineAt(selection.from);
      const toLine = view.state.doc.lineAt(selection.to);
      if (edges.start && selection.from > fromLine.from) insert = '\n\n' + insert;
      if (edges.end && selection.to < toLine.to) insert += '\n\n';
      return insert;
    };

    const insert = convertedText(preferences, matrix);
    if (!tableTarget && preferences.showPasteOptions && !clipboard.files.length
      && text.length + htmlText.length + meoText.length + selection.to - selection.from <= maxPasteOptionsCharacters) {
      const literal = view.state.toText(text).toString();
      const formatted = (preferences.pasteHtml && preferences.convertTables ? insert
        : convertedText({ ...preferences, pasteHtml: true, convertTables: true },
          preferences.pasteHtml ? matrix : readMatrix(true))) ?? literal;
      const plain = meoMatrix ? clipboardTableText(meoMatrix.cells, cell => clipboardMarkdownText(markdown, cell, true))
        : readTsv() ? literal
        : html ? clipboardHtmlText(html) || literal
        : clipboardMarkdownText(markdown, literal);
      if (formatted !== literal || plain !== literal) {
        view.plugin(pasteOptionsMenu)?.offer(
          { formatted: view.state.toText(formatted).toString(), plain },
          captureScrollCurrentness()
        );
      }
    }
    if (insert === null) return false;
    event.preventDefault();
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert },
      selection: EditorSelection.cursor(selection.from + insert.length), annotations: Transaction.userEvent.of('input.paste'),
      scrollIntoView: true });
    return true;
  }
})];
