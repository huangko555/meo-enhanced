import { countColumn, type EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { parseFootnotes } from './footnotes';
import type { MarkdownBlockIndent, MarkdownTaskIndent } from '../../../src/foundation/markdownDocumentContext';
import { getCodeContainerColumns, parseBlockLinePrefix } from '../editor/codeBlockSource';

export { getCodeContainerColumns, getCodeBlockLastLine, getCodeBlockSourceLines, indentedCodeBlockAt, parseBlockLinePrefix } from '../editor/codeBlockSource';

export const liveBlockIndentProperty = '--meo-live-block-indent';

export type TaskListIndent = MarkdownTaskIndent;

/** A checkbox replaces the list marker as well as [ ]. Descendants must use
 * that same visual width without changing Markdown's source indentation. */
export function getLiveTaskListIndent(state: EditorState, from: number, node: SyntaxNode | null = null): TaskListIndent {
  const line = state.doc.lineAt(from);
  let checkboxes = 0;
  let sourceColumns = 0;
  for (let parent: SyntaxNode | null = node ?? syntaxTree(state).resolveInner(from, 1); parent; parent = parent.parent) {
    if (parent.name !== 'ListItem') continue;
    const mark = parent.getChild('ListMark');
    if (!mark) continue;
    const markerLine = state.doc.lineAt(mark.from);
    if (markerLine.number === line.number) continue;
    const end = mark.to - markerLine.from;
    const padding = /^[ \t]+(?=\[[ xX~\-]\][ \t])/.exec(markerLine.text.slice(end))?.[0];
    if (!padding) continue;
    checkboxes += 1;
    // One source column remains as the checkbox-to-body gap.
    sourceColumns += countColumn(markerLine.text, state.tabSize, end + padding.length)
      - countColumn(markerLine.text, state.tabSize, mark.from - markerLine.from) - 1;
  }
  return { checkboxes, sourceColumns };
}

export function liveTaskListIndentCssValue(indent: TaskListIndent): string {
  return indent.checkboxes
    ? 'calc(' + indent.checkboxes + ' * var(--meo-task-checkbox-size) - ' + indent.sourceColumns + ' * var(--meo-live-container-ch))' : '0px';
}

export type LiveBlockIndent = MarkdownBlockIndent;

export type LiveBlockIndentValue = number | LiveBlockIndent;

function hasListItemAncestor(node: SyntaxNode | null): boolean {
  for (let current = node; current; current = current.parent) {
    if (current.name === 'ListItem') {
      return true;
    }
  }
  return false;
}

export function getLiveListBlockIndentColumns(
  state: EditorState,
  from: number,
  syntaxNode: SyntaxNode | null = null
): number {
  const line = state.doc.lineAt(from);
  const leadingWhitespace = /^[ \t]*/.exec(line.text)?.[0] ?? '';
  if (!leadingWhitespace) {
    return 0;
  }

  const resolvedNode = syntaxNode ?? syntaxTree(state).resolveInner(
    Math.min(line.to, line.from + leadingWhitespace.length),
    1
  );
  if (!hasListItemAncestor(resolvedNode)) {
    return 0;
  }

  return parseBlockLinePrefix(leadingWhitespace, state.tabSize).columns;
}

export function getLiveBlockIndent(
  state: EditorState,
  from: number,
  syntaxNode: SyntaxNode | null = null
): LiveBlockIndent {
  const line = state.doc.lineAt(from);
  const definition = parseFootnotes(state).definitions.find((candidate) => (
    candidate.isPrimary &&
    candidate.number !== null &&
    line.from > candidate.lineFrom &&
    line.from <= candidate.lineTo
  ));
  const isCode = syntaxNode?.name === 'CodeBlock' || syntaxNode?.name === 'FencedCode';
  const prefix = parseBlockLinePrefix(isCode ? line.text.slice(0, syntaxNode!.from - line.from) : line.text, state.tabSize);
  const containerColumns = isCode ? getCodeContainerColumns(state, syntaxNode!) : prefix.columns;
  const baseline = definition ? 4 : 0;
  const quoteColumns = prefix.quoteColumns.map((column) => Math.max(0, column - baseline));
  const listColumns = isCode ? containerColumns : getLiveListBlockIndentColumns(state, from, syntaxNode);
  const taskIndent = getLiveTaskListIndent(state, from, syntaxNode);
  const quoteTaskIndents: TaskListIndent[] = [];
  for (let parent: SyntaxNode | null = syntaxNode ?? syntaxTree(state).resolveInner(from, 1); parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quoteTaskIndents.unshift(getLiveTaskListIndent(state, from, parent));
  }
  return {
    ...(taskIndent.checkboxes ? { taskIndent } : {}),
    ...(quoteTaskIndents.some(indent => indent.checkboxes) ? { quoteTaskIndents } : {}),
    // Hidden and editable quote prefixes share the same source column widths.
    columns: quoteColumns.length
      ? Math.max(0, containerColumns - baseline)
      : definition ? Math.max(0, listColumns - baseline) : listColumns,
    footnoteNumber: definition?.number ?? null,
    ...(quoteColumns.length ? { quoteColumns } : {})
  };
}

export function liveBlockIndentKey(indent: LiveBlockIndentValue): string {
  return typeof indent === 'number'
    ? `${Math.max(0, indent)}:0`
    : `${Math.max(0, indent.columns)}:${indent.footnoteNumber ?? 0}:${indent.quoteColumns?.join(',') ?? ''}:${JSON.stringify(indent.taskIndent)}:${JSON.stringify(indent.quoteTaskIndents)}`;
}

export function liveBlockIndentCssValue(indent: LiveBlockIndentValue): string | null {
  if (typeof indent === 'number') {
    return indent > 0 ? `calc(${indent} * var(--meo-live-container-ch))` : null;
  }
  const columns = Math.max(0, indent.columns);
  const taskOffset = indent.taskIndent?.checkboxes ? ' + ' + liveTaskListIndentCssValue(indent.taskIndent) : '';
  if (indent.footnoteNumber === null) {
    return columns > 0 || taskOffset ? `calc(${columns} * var(--meo-live-container-ch)${taskOffset})` : null;
  }
  const markerColumns = String(indent.footnoteNumber).length + 1;
  // Container spacing belongs to the Live font, even inside source-font panels.
  return `calc(${columns + markerColumns} * var(--meo-live-container-ch) + 0.45 * var(--meo-user-editor-font-size, var(--meo-font-live-size))${taskOffset})`;
}

export function applyLiveBlockIndent(element: HTMLElement, indent: LiveBlockIndentValue): void {
  const cssValue = liveBlockIndentCssValue(indent);
  element.classList.toggle('meo-live-indented-block', cssValue !== null);
  if (cssValue === null) {
    element.style.removeProperty(liveBlockIndentProperty);
  } else {
    element.style.setProperty(liveBlockIndentProperty, cssValue);
  }

  const quotes = typeof indent === 'number' ? [] : indent.quoteColumns ?? [];
  element.classList.toggle('meo-live-quoted-block', quotes.length > 0);
  if (!quotes.length) {
    element.style.removeProperty('--meo-live-block-quote-depth');
    element.style.removeProperty('--meo-live-block-quote-bars');
    element.style.removeProperty('--meo-live-block-quote-base');
    return;
  }
  element.style.setProperty('--meo-live-block-quote-depth', String(quotes.length));
  element.style.setProperty('--meo-live-block-quote-base',
    typeof indent !== 'number' && indent.footnoteNumber !== null
      ? `calc(${String(indent.footnoteNumber).length + 1} * var(--meo-live-container-ch) + 0.45 * var(--meo-user-editor-font-size, var(--meo-font-live-size)))` : '0px');
  const rule = 'var(--meo-semantic-blockquoteBorder)';
  element.style.setProperty('--meo-live-block-quote-bars', quotes.map((column, index) => {
    const taskOffset = typeof indent !== 'number' && indent.quoteTaskIndents?.[index];
    return `linear-gradient(${rule}, ${rule}) calc(${column} * var(--meo-live-container-ch) + ${taskOffset ? liveTaskListIndentCssValue(taskOffset) : '0px'}) 0 / 3px 100% no-repeat`;
  }).join(','));
}
