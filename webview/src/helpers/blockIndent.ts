import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

export const liveBlockIndentProperty = '--meo-live-block-indent';

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

export function applyLiveBlockIndent(element: HTMLElement, indentColumns: number): void {
  element.classList.toggle('meo-live-indented-block', indentColumns > 0);
  if (indentColumns <= 0) {
    element.style.removeProperty(liveBlockIndentProperty);
    return;
  }
  element.style.setProperty(liveBlockIndentProperty, `${indentColumns}ch`);
}
