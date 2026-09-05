import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { parseFootnotes } from './footnotes';

export const liveBlockIndentProperty = '--meo-live-block-indent';

export type LiveBlockIndent = {
  columns: number;
  footnoteNumber: number | null;
};

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

  return Array.from(leadingWhitespace).reduce(
    (columns, character) => columns + (character === '\t' ? state.tabSize : 1),
    0
  );
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
  const listColumns = getLiveListBlockIndentColumns(state, from, syntaxNode);
  return {
    // A footnote composite already consumes four source columns. Only nesting
    // beyond that baseline contributes additional visual block indentation.
    columns: definition ? Math.max(0, listColumns - 4) : listColumns,
    footnoteNumber: definition?.number ?? null
  };
}

export function liveBlockIndentKey(indent: LiveBlockIndentValue): string {
  return typeof indent === 'number'
    ? `${Math.max(0, indent)}:0`
    : `${Math.max(0, indent.columns)}:${indent.footnoteNumber ?? 0}`;
}

export function liveBlockIndentCssValue(indent: LiveBlockIndentValue): string | null {
  if (typeof indent === 'number') {
    return indent > 0 ? `${indent}ch` : null;
  }
  const columns = Math.max(0, indent.columns);
  if (indent.footnoteNumber === null) {
    return columns > 0 ? `${columns}ch` : null;
  }
  const markerColumns = String(indent.footnoteNumber).length + 1;
  return `calc(${columns + markerColumns}ch + 0.45em)`;
}

export function applyLiveBlockIndent(element: HTMLElement, indent: LiveBlockIndentValue): void {
  const cssValue = liveBlockIndentCssValue(indent);
  element.classList.toggle('meo-live-indented-block', cssValue !== null);
  if (cssValue === null) {
    element.style.removeProperty(liveBlockIndentProperty);
    return;
  }
  element.style.setProperty(liveBlockIndentProperty, cssValue);
}
