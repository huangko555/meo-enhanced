import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { getCodeBlockSourceLines, parseBlockLinePrefix } from './blockIndent';
import { getFencedCodeInfo, currentSyntaxTree } from './markdownSyntax';
import { insertLiteralSourceNewline } from '../editor/indentedCodeEditing';
import { completedBackgroundMarkdownStructure } from '../editor/backgroundMarkdownStructure';
import { isGraphBlockLanguage } from '../editor/documentBlocks';

type EditingSource = { anchor: number; source: string; language: string;
  opening: ReturnType<EditorState['doc']['lineAt']>; closing: ReturnType<EditorState['doc']['lineAt']> };
const editingSourceCache = new WeakMap<EditorState, { anchor: number; to: number; value: EditingSource | null }>();

/** Read only an already owned editing span. This small local parse is never
 * published as document syntax and cannot absorb text beyond the known fence.
 * Removing matching outer indentation lets the existing source reader retain
 * list/quote prefixes, tabs and payload indentation without a second grammar. */
export function boundedMermaidEditingSource(state: EditorState, anchor: number, to: number): EditingSource | null {
  if (anchor < 0 || to > state.doc.length || to <= anchor || to - anchor > 32_768) return null;
  const cached = editingSourceCache.get(state);
  if (cached?.anchor === anchor && cached.to === to) return cached.value;
  let value: EditingSource | null = null;
  const opening = state.doc.lineAt(anchor), closing = state.doc.lineAt(to - 1);
  if (opening.from === anchor && closing.to === to && closing.number > opening.number) {
    // Remove whole CommonMark indentation units. Keeping the remaining one to
    // three spaces preserves physical tab stops in quote/list payload prefixes.
    const leading = /^ */.exec(opening.text)![0];
    const indentation = leading.slice(0, Math.floor(leading.length / 4) * 4);
    const lines = state.doc.sliceString(anchor, to).split('\n');
    if ((!indentation || indentation.length % state.tabSize === 0 || !lines.some(line => line.includes('\t')))
      && lines.every(line => line.startsWith(indentation) || !line.trim())) {
      const text = lines.map(line => line.startsWith(indentation) ? line.slice(indentation.length) : '').join('\n');
      const local = EditorState.create({ doc: text, extensions: EditorState.tabSize.of(state.tabSize) });
      const tree = markdownLanguage.parser.parse(text);
      let fence: SyntaxNode | null = null;
      tree.iterate({ enter(node) { if (node.name === 'FencedCode' && !fence) { fence = node.node; return false; } } });
      if (fence) {
        const node = fence as SyntaxNode;
        const language = getFencedCodeInfo(local, { node })?.split(/\s+/)[0].toLowerCase();
        if (local.doc.lineAt(node.from).number === 1 && local.doc.lineAt(node.to - 1).number === local.doc.lines
          && node.lastChild?.name === 'CodeMark' && local.doc.lineAt(node.lastChild.from).number === local.doc.lines
          && isGraphBlockLanguage(state, language)) {
          const source = getCodeBlockSourceLines(local, node).filter(line => !line.isFence)
            .map(line => ' '.repeat(line.payloadInset) + local.doc.sliceString(line.prefixTo, line.to)).join('\n');
          value = { anchor, source, language: language!, opening, closing };
        }
      }
    }
  }
  editingSourceCache.set(state, { anchor, to, value });
  return value;
}

export function mermaidSourceAt(state: EditorState, position = state.selection.main.head) {
  const line = state.doc.lineAt(Math.max(0, Math.min(position, state.doc.length)));
  // Passive state-field updates also run in Source; do not advance its parser.
  const tree = completedBackgroundMarkdownStructure(state) ?? currentSyntaxTree(state);
  let node: SyntaxNode | null = tree.resolveInner(line.to, -1);
  for (; node; node = node.parent) {
    if (node.name !== 'FencedCode') continue;
    const language = getFencedCodeInfo(state, { node })?.split(/\s+/)[0].toLowerCase();
    if (!isGraphBlockLanguage(state, language)) return null;
    const opening = state.doc.lineAt(node.from),
      closing = state.doc.lineAt(Math.max(node.from, node.to - 1));
    const lines = getCodeBlockSourceLines(state, node).filter((line) => !line.isFence && line.from > opening.from);
    if (!lines.length) return null;
    const first = lines[0]!,
      last = lines[lines.length - 1]!;
    return {
      language: language!,
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
