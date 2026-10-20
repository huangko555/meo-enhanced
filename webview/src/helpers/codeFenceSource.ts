import type { EditorState, Text } from '@codemirror/state';
import { IterMode, type Tree } from '@lezer/common';
import type { MarkdownCodeFence } from '../../../src/foundation/markdownDocumentContext';
import { markdownStructureIdentity } from '../editor/markdownStructure';
import { currentSyntaxTree, getFencedCodeInfo, withMarkdownSyntaxSnapshot } from './markdownSyntax';
import { getLiveBlockIndent } from './blockIndent';

const cache = new WeakMap<Text, { tree: Tree; tabSize: number; fences: readonly MarkdownCodeFence[] }>();

export function adoptCodeFenceSource(doc: Text, tree: Tree, tabSize: number, fences: readonly MarkdownCodeFence[]): void {
  cache.set(doc, { tree: markdownStructureIdentity(tree), tabSize, fences });
}

/** Read one published outer structure; never advance an embedded parser. The
 * worker seeds this index before publishing large-document syntax to the UI. */
export function readCodeFenceSource(state: EditorState, tree = currentSyntaxTree(state)): readonly MarkdownCodeFence[] {
  const cached = cache.get(state.doc);
  if (cached?.tree === markdownStructureIdentity(tree) && cached.tabSize === state.tabSize) return cached.fences;
  const fences = discoverCodeFences(state, tree);
  adoptCodeFenceSource(state.doc, tree, state.tabSize, fences);
  return fences;
}

function discoverCodeFences(state: EditorState, tree: Tree): MarkdownCodeFence[] {
  const fences: MarkdownCodeFence[] = [];
  // Indentation and footnote readers must see this same completed structure.
  withMarkdownSyntaxSnapshot(state, tree, () => tree.iterate({
    mode: IterMode.IgnoreMounts,
    enter(node) {
      if (node.name !== 'FencedCode') return;
      const startLine = state.doc.lineAt(node.from);
      const endLine = state.doc.lineAt(Math.max(node.to - 1, node.from));
      if (startLine.number >= state.doc.lines) return false;
      const contentStartLine = state.doc.line(startLine.number + 1);
      const lastChild = node.node.lastChild;
      const hasClosingFence = lastChild?.name === 'CodeMark'
        && state.doc.lineAt(lastChild.from).number === endLine.number;
      const contentEndLineNumber = endLine.number - (hasClosingFence ? 1 : 0);
      if (contentStartLine.number > contentEndLineNumber) return false;
      const contentEndLine = state.doc.line(contentEndLineNumber);
      fences.push({
        anchor: node.from, start: startLine.from, end: endLine.to, endLineFrom: endLine.from,
        indentColumns: getLiveBlockIndent(state, node.from, node.node), language: getFencedCodeInfo(state, node) || '',
        contentFrom: contentStartLine.from, contentTo: contentEndLine.to, contentStartLine: contentStartLine.number,
        lineCount: contentEndLine.number - contentStartLine.number + 1
      });
      return false;
    }
  }));
  return fences;
}
