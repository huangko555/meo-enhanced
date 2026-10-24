import { countColumn, type EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { IterMode, type SyntaxNode, type Tree } from '@lezer/common';

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

/** Continue only real container markers and whitespace, never a literal > in code. */
export function getIndentedCodeLinePrefix(state: EditorState, node: SyntaxNode, line = state.doc.lineAt(node.from)): string {
  let quoteDepth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quoteDepth += 1;
  }
  let offset = 0, quotes = 0;
  while (offset < line.length) {
    const character = line.text[offset];
    if (character === '>') {
      if (quotes === quoteDepth) break;
      quotes += 1;
    } else if (character !== ' ' && character !== '\t') break;
    offset += 1;
  }
  return line.text.slice(0, offset);
}

/** Markdown excludes trailing blanks from CodeBlock nodes. Explicitly indented
 * blank rows still belong to the editable code surface until they are outdented. */
export function getCodeBlockLastLine(state: EditorState, node: SyntaxNode, uptoLine = state.doc.lines) {
  let last = state.doc.lineAt(Math.max(node.to - 1, node.from));
  if (node.name !== 'CodeBlock') return last;
  let quoteDepth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quoteDepth += 1;
  }
  while (last.number < uptoLine) {
    const next = state.doc.line(last.number + 1);
    const prefix = parseBlockLinePrefix(next.text, state.tabSize);
    if (prefix.content || prefix.quoteColumns.length !== quoteDepth
      || prefix.columns < getCodeContainerColumns(state, node, next) + 4) break;
    last = next;
  }
  return last;
}

/** Find the real Markdown block, including its explicitly indented trailing rows.
 * The backwards walk is limited to the adjacent blank run, never the document. */
export function indentedCodeBlockAt(state: EditorState, position: number, tree: Tree = syntaxTree(state)): SyntaxNode | null {
  const target = state.doc.lineAt(position);
  let line = target;
  for (;;) {
    for (const side of [-1, 1] as const) {
      for (let node: SyntaxNode | null = tree.cursor(IterMode.IgnoreMounts).moveTo(line.to, side).node; node; node = node.parent) {
        if (node.name === 'FencedCode') return null;
        if (node.name === 'CodeBlock') {
          return getCodeBlockLastLine(state, node, target.number).number >= target.number ? node : null;
        }
      }
    }
    const prefix = parseBlockLinePrefix(line.text, state.tabSize);
    if (line.number === 1 || prefix.content || prefix.columns < 4) return null;
    line = state.doc.line(line.number - 1);
  }
}

/** Source layout for a FencedCode or CodeBlock. Payload indentation is retained,
 * including the visible remainder of tabs crossing a container boundary. */
export function getCodeBlockSourceLines(state: EditorState, node: SyntaxNode) {
  const firstLine = state.doc.lineAt(node.from);
  const lastLine = getCodeBlockLastLine(state, node);
  const openingPrefix = firstLine.text.slice(0, node.from - firstLine.from);
  const marks = node.getChildren('CodeMark');
  const fenceIndent = node.name === 'FencedCode'
    ? Math.max(0, countColumn(openingPrefix, state.tabSize) - getCodeContainerColumns(state, node)) : 4;
  const lines: Array<{from:number;to:number;prefixTo:number;prefixColumns:number;quoteDepth:number;payloadInset:number;isFence:boolean}> = [];
  let quoteDepth = 0;
  const listMarks: SyntaxNode[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quoteDepth += 1;
    const mark = parent.name === 'ListItem' ? parent.getChild('ListMark') : null;
    if (mark) listMarks.push(mark);
  }
  let markIndex = 0;
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo += 1) {
    const line = state.doc.line(lineNo);
    while (markIndex < marks.length && marks[markIndex]!.to <= line.from) markIndex += 1;
    const nextMark = marks[markIndex];
    const mark = nextMark && nextMark.from <= line.to ? nextMark : undefined;
    let prefixTo = mark?.from ?? line.from;
    const consumedColumns = getCodeContainerColumns(state, node, line) + fenceIndent;
    // A partial tab after a quote can make CodeText.from point into real code.
    // Consume physical container columns instead, never payload characters.
    if (!mark) {
      for (const listMark of listMarks) {
        if (listMark.from >= line.from && listMark.to <= line.to) prefixTo = Math.max(prefixTo, listMark.to);
      }
      let columns = countColumn(line.text, state.tabSize, prefixTo - line.from);
      let quotes = (state.doc.sliceString(line.from, prefixTo).match(/>/g) ?? []).length;
      while (prefixTo < line.to && (columns < consumedColumns || quotes < quoteDepth)) {
        const character = line.text[prefixTo - line.from];
        if (character === '>') {
          if (quotes === quoteDepth) break;
          quotes += 1;
        } else if (character !== ' ' && character !== '\t') break;
        columns += character === '\t' ? state.tabSize - columns % state.tabSize : 1;
        prefixTo += 1;
      }
    }
    const prefix = state.doc.sliceString(line.from, prefixTo);
    const prefixColumns = countColumn(prefix, state.tabSize);
    lines.push({from:line.from,to:line.to,prefixTo,prefixColumns,quoteDepth:(prefix.match(/>/g) ?? []).length,
      payloadInset:mark?0:Math.max(0,prefixColumns-consumedColumns),isFence:Boolean(mark)});
  }
  return lines;
}
