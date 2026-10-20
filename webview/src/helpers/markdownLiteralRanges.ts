import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { markdownStructureIdentity } from '../editor/markdownStructure';
import type { MarkdownLiteralRange } from '../../../src/foundation/markdownDocumentContext';

type SourceRange = MarkdownLiteralRange;
const literalNodes = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'InlineMathExcluded', 'Autolink', 'URL', 'LinkTitle', 'LinkLabel', 'Comment', 'CommentBlock', 'HTMLBlock', 'Subscript', 'Superscript']);
const cache = new WeakMap<Tree, SourceRange[]>();

export function adoptMarkdownLiteralRanges(tree: Tree, ranges: SourceRange[]): void {
  cache.set(markdownStructureIdentity(tree), ranges);
}

/** Prose transforms share the parser's literal containers, while link labels remain prose. */
export function collectMarkdownLiteralRanges(state: EditorState, tree: Tree, scope?: { from: number; to: number }): readonly SourceRange[] {
  const identity = markdownStructureIdentity(tree);
  const cached = !scope && cache.get(identity);
  if (cached) return cached;
  const ranges: SourceRange[] = [];
  const codeTags: Array<{ from: number; to: number; name: string }> = [];
  tree.iterate({ ...scope, enter(node) {
    if (node.name === 'InlineHTMLCode') {
      ranges.push({ from: node.from, to: node.to, htmlCode: { from: node.node.firstChild!.to, to: node.node.lastChild!.from } });
      return false;
    }
    if (literalNodes.has(node.name)) {
      ranges.push({ from: node.from, to: node.to, ...(node.name === 'Subscript' || node.name === 'Superscript' ? { script: true } : {}) });
      return false;
    }
    if (node.name !== 'HTMLTag') return;
    ranges.push({ from: node.from, to: node.to });
    const tag = /^<(\/?)(code|pre)\b/i.exec(state.sliceDoc(node.from, node.to));
    if (!tag) return;
    const name = tag[2]!.toLowerCase();
    if (!tag[1]) codeTags.push({ from: node.from, to: node.to, name });
    else {
      let index = codeTags.length - 1;
      while (index >= 0 && codeTags[index]!.name !== name) index -= 1;
      if (index >= 0) {
        const open = codeTags[index]!;
        ranges.push({ from: open.from, to: node.to, htmlCode: { from: open.to, to: node.from } });
        codeTags.splice(index);
      }
    }
  } });
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  if (!scope) cache.set(identity, ranges);
  return ranges;
}
