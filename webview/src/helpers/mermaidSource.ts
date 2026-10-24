import { EditorSelection, Transaction, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { getCodeBlockSourceLines, parseBlockLinePrefix } from './blockIndent';
import { getFencedCodeInfo, currentSyntaxTree } from './markdownSyntax';
import { insertLiteralSourceNewline } from '../editor/indentedCodeEditing';

export function mermaidSourceAt(state: EditorState, position = state.selection.main.head) {
  let node: SyntaxNode | null = currentSyntaxTree(state).resolveInner(
    state.doc.lineAt(Math.max(0, Math.min(position, state.doc.length))).to,
    -1
  );
  for (; node; node = node.parent) {
    if (node.name !== 'FencedCode') continue;
    if (getFencedCodeInfo(state, { node }) !== 'mermaid') return null;
    const opening = state.doc.lineAt(node.from),
      closing = state.doc.lineAt(Math.max(node.from, node.to - 1));
    const lines = getCodeBlockSourceLines(state, node).filter((line) => !line.isFence && line.from > opening.from);
    if (!lines.length) return null;
    const first = lines[0]!,
      last = lines[lines.length - 1]!;
    return {
      anchor: opening.from,
      from: node.from,
      to: node.to,
      opening,
      closing,
      lines,
      bodyFrom: first.prefixTo,
      bodyTo: last.to,
      source: lines
        .map((line) => ' '.repeat(line.payloadInset) + state.doc.sliceString(line.prefixTo, line.to))
        .join('\n'),
      prefix:
        state.doc.sliceString(first.from, first.prefixTo) || parseBlockLinePrefix(closing.text, state.tabSize).prefix,
      closed: node.lastChild?.name === 'CodeMark' && closing.number > opening.number
    };
  }
  return null;
}

export function mermaidSourceForAnchor(state: EditorState, anchor: number) {
  if (!Number.isFinite(anchor) || anchor < 0 || anchor > state.doc.length) return null;
  const source = mermaidSourceAt(state, state.doc.lineAt(anchor).to);
  return source?.anchor === anchor ? source : null;
}

function selectedMermaidSource(view: EditorView) {
  if (!view.dom.classList.contains('meo-mode-live') || view.state.readOnly || view.state.selection.ranges.length !== 1)
    return null;
  const source = mermaidSourceAt(view.state),
    selection = view.state.selection.main;
  return source && selection.from >= source.bodyFrom && selection.to <= source.bodyTo ? source : null;
}

export function mermaidPasteText(view: EditorView, text: string): string | null {
  const source = selectedMermaidSource(view);
  return source ? text.replace(/\r\n?/g, '\n').replaceAll('\n', '\n' + source.prefix) : null;
}

export function insertMermaidNewline(view: EditorView): boolean {
  const source = selectedMermaidSource(view);
  if (!source) return false;
  return insertLiteralSourceNewline(view, source.prefix);
}

export function indentMermaidSource(view: EditorView, outdent: boolean): boolean {
  const source = selectedMermaidSource(view);
  if (!source) return false;
  const selection = view.state.selection.main;
  const changes = source.lines
    .filter((line) => line.to >= selection.from && line.from <= (selection.empty ? selection.to : selection.to - 1))
    .map((line) => ({
      from: line.prefixTo,
      to:
        line.prefixTo +
        (outdent ? (/^(?: {1,2}|\t)/.exec(view.state.doc.sliceString(line.prefixTo, line.to))?.[0].length ?? 0) : 0),
      insert: outdent ? '' : '  '
    }));
  view.dispatch({ changes, annotations: Transaction.userEvent.of('input.indent') });
  return true;
}

export function selectMermaidSource(view: EditorView, anchor: number): void {
  const source = mermaidSourceForAnchor(view.state, anchor);
  if (!source) return;
  view.dispatch({ selection: EditorSelection.single(source.bodyFrom, source.bodyTo) });
  view.focus();
}
