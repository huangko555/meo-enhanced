import { countColumn, type EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { parseFootnotes } from './footnotes';

export const liveBlockIndentProperty = '--meo-live-block-indent';

export type TaskListIndent = { checkboxes: number; sourceColumns: number };

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

export type LiveBlockIndent = {
  columns: number;
  footnoteNumber: number | null;
  quoteColumns?: readonly number[];
  taskIndent?: TaskListIndent;
  quoteTaskIndents?: readonly TaskListIndent[];
};

export type LiveBlockIndentValue = number | LiveBlockIndent;

/** Source offsets remain intact; only the rendered shell consumes this prefix. */
export function parseBlockLinePrefix(text: string, tabSize = 4) {
  let offset = 0;
  let columns = 0;
  const quoteColumns: number[] = [];
  while (offset < text.length) {
    const character = text[offset];
    if (character === ' ' || character === '\t') {
      columns += character === '\t' ? tabSize - columns % tabSize : 1;
    } else if (character === '>') {
      quoteColumns.push(columns);
      columns += 1;
    } else {
      break;
    }
    offset += 1;
  }
  return { prefix: text.slice(0, offset), content: text.slice(offset), columns, quoteColumns };
}

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

/** Physical source columns consumed by Markdown containers, before code indentation. */
export function getCodeContainerColumns(state: EditorState, node: SyntaxNode, line = state.doc.lineAt(node.from)): number {
  let columns = 0;
  let quoteDepth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quoteDepth += 1;
    if (parent.name === 'FootnoteDefinition') columns = Math.max(columns, 4);
    if (parent.name !== 'ListItem') continue;
    const mark = parent.getChild('ListMark');
    if (!mark) continue;
    const markerLine = state.doc.lineAt(mark.to);
    const end = mark.to - markerLine.from;
    const whitespace = /^[ \t]*/.exec(markerLine.text.slice(end))?.[0] ?? '';
    const markerColumn = countColumn(markerLine.text, state.tabSize, end);
    const padding = countColumn(markerLine.text, state.tabSize, end + whitespace.length) - markerColumn;
    columns = Math.max(columns, markerColumn + (padding > 4 ? 1 : padding));
  }
  if (quoteDepth) {
    const prefix = parseBlockLinePrefix(line.text, state.tabSize);
    const lastQuote = prefix.quoteColumns[Math.min(quoteDepth, prefix.quoteColumns.length) - 1];
    let quoteOffset = -1;
    for (let depth = 0; depth < quoteDepth; depth += 1) quoteOffset = line.text.indexOf('>', quoteOffset + 1);
    if (lastQuote !== undefined && quoteOffset >= 0) {
      const afterQuote = line.text[quoteOffset + 1];
      columns = Math.max(columns, lastQuote + 1 + (afterQuote === ' ' || afterQuote === '\t' ? 1 : 0));
    }
  }
  return columns;
}

/** Source layout for a FencedCode or CodeBlock. Payload indentation is retained,
 * including the visible remainder of tabs crossing a container boundary. */
export function getCodeBlockSourceLines(state: EditorState, node: SyntaxNode) {
  const firstLine = state.doc.lineAt(node.from);
  const lastLine = state.doc.lineAt(Math.max(node.to - 1, node.from));
  const openingPrefix = firstLine.text.slice(0, node.from - firstLine.from);
  const contents = node.getChildren('CodeText');
  const marks = node.getChildren('CodeMark');
  const fenceIndent = node.name === 'FencedCode'
    ? Math.max(0, parseBlockLinePrefix(openingPrefix, state.tabSize).columns - getCodeContainerColumns(state, node)) : 4;
  const lines: Array<{from:number;to:number;prefixTo:number;prefixColumns:number;quoteDepth:number;payloadInset:number;isFence:boolean}> = [];
  let contentIndex = 0;
  let markIndex = 0;
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo += 1) {
    const line = state.doc.line(lineNo);
    while (contentIndex < contents.length && contents[contentIndex]!.to <= line.from) contentIndex += 1;
    while (markIndex < marks.length && marks[markIndex]!.to <= line.from) markIndex += 1;
    const nextContent = contents[contentIndex];
    const nextMark = marks[markIndex];
    const content = nextContent && nextContent.from <= line.to ? nextContent : undefined;
    const mark = nextMark && nextMark.from <= line.to ? nextMark : undefined;
    let prefixTo = content ? Math.max(line.from, content.from)
      : mark?.from ?? line.from + Math.min(openingPrefix.length, parseBlockLinePrefix(line.text, state.tabSize).prefix.length);
    const consumedColumns = getCodeContainerColumns(state, node, line) + fenceIndent;
    if (content && node.name === 'FencedCode') {
      while (prefixTo < line.to && /[ \t]/.test(state.doc.sliceString(prefixTo, prefixTo + 1))
        && parseBlockLinePrefix(state.doc.sliceString(line.from, prefixTo), state.tabSize).columns < consumedColumns) prefixTo += 1;
    }
    const prefix = parseBlockLinePrefix(state.doc.sliceString(line.from, prefixTo), state.tabSize);
    lines.push({from:line.from,to:line.to,prefixTo,prefixColumns:prefix.columns,quoteDepth:prefix.quoteColumns.length,
      payloadInset:content?Math.max(0,prefix.columns-consumedColumns):0,isFence:Boolean(mark)});
  }
  return lines;
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
  const quoteColumns = prefix.quoteColumns.map((column, depth) => Math.max(0, column - depth - baseline));
  const listColumns = isCode ? containerColumns : getLiveListBlockIndentColumns(state, from, syntaxNode);
  const taskIndent = getLiveTaskListIndent(state, from, syntaxNode);
  const quoteTaskIndents: TaskListIndent[] = [];
  for (let parent: SyntaxNode | null = syntaxNode ?? syntaxTree(state).resolveInner(from, 1); parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quoteTaskIndents.unshift(getLiveTaskListIndent(state, from, parent));
  }
  return {
    ...(taskIndent.checkboxes ? { taskIndent } : {}),
    ...(quoteTaskIndents.some(indent => indent.checkboxes) ? { quoteTaskIndents } : {}),
    // Inactive quote markers collapse by one column per level. Leave one
    // additional column between the innermost rule and the rendered content.
    columns: quoteColumns.length
      ? Math.max(0, containerColumns - quoteColumns.length + 1 - baseline)
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
  return `calc(${columns + markerColumns} * var(--meo-live-container-ch) + 0.45em${taskOffset})`;
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
      ? `calc(${String(indent.footnoteNumber).length + 1} * var(--meo-live-container-ch) + 0.45em)` : '0px');
  const rule = 'var(--meo-semantic-blockquoteBorder)';
  element.style.setProperty('--meo-live-block-quote-bars', quotes.map((column, index) => {
    const taskOffset = typeof indent !== 'number' && indent.quoteTaskIndents?.[index];
    return `linear-gradient(${rule}, ${rule}) calc(${column} * var(--meo-live-container-ch) + ${taskOffset ? liveTaskListIndentCssValue(taskOffset) : '0px'}) 0 / 3px 100% no-repeat`;
  }).join(','));
}
