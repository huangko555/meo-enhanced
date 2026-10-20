import { EditorState, type ChangeSet, type Text } from '@codemirror/state';
import { IterMode, type SyntaxNode, type Tree } from '@lezer/common';
import { hasSameLiveMarkdownOutsideBlock } from './helpers/livePresentationSyntax';
import { mapUnchangedMarkdownDocumentContext, type MarkdownSourceContext } from './editor/markdownSourceContext';
import { collectMarkdownLiteralRanges } from './helpers/markdownLiteralRanges';

const plainCharacters = /^[\p{L}\p{N} ,.!?，。！？；：、…-]*$/u;
const globalParagraphSyntax = /[<$]|\[\^|\^\[/;

function paragraphAt(tree: Tree, position: number): SyntaxNode | undefined {
  for (const side of [1, -1] as const) {
    let paragraph: SyntaxNode | undefined;
    for (let node: SyntaxNode | null = tree.cursor(IterMode.IgnoreMounts).moveTo(position, side).node; node; node = node.parent) {
      if (node.name === 'FootnoteDefinition') { paragraph = undefined; break; }
      if (node.name === 'Paragraph') paragraph = node;
    }
    if (paragraph) return paragraph;
  }
}

/** Project only ordinary text inside one unchanged paragraph. Changed syntax,
 * definitions, line structure or an inconclusive outside proof use discovery.
 * No partial or different-grammar tree may be supplied by the worker owner. */
export function projectMarkdownDocumentContext(before: MarkdownSourceContext, doc: Text, tree: Tree,
  tabSize: number, changes: ChangeSet): MarkdownSourceContext | undefined {
  if (before.tabSize !== tabSize || changes.length !== before.doc.length || changes.newLength !== doc.length
    || before.tree.length !== before.doc.length || tree.length !== doc.length || tree.type.name !== 'Document') return;
  if (changes.empty) return before.doc === doc && before.tree === tree ? before : undefined;
  const paragraphs: Array<{ previous: SyntaxNode; next: SyntaxNode }> = [];
  let valid = true;
  changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
    if (!valid || !plainCharacters.test(before.doc.sliceString(from, to)) || !plainCharacters.test(doc.sliceString(nextFrom, nextTo))) { valid = false; return; }
    const previous = paragraphAt(before.tree, from), next = paragraphAt(tree, nextFrom);
    if (!previous || !next || to > previous.to || nextTo > next.to
      || paragraphs[0] && (paragraphs[0].previous.from !== previous.from || paragraphs[0].previous.to !== previous.to
        || paragraphs[0].next.from !== next.from || paragraphs[0].next.to !== next.to)) { valid = false; return; }
    paragraphs.push({ previous, next });
  });
  const oldParagraph = paragraphs[0]?.previous, nextParagraph = paragraphs[0]?.next;
  if (!valid || !oldParagraph || !nextParagraph || oldParagraph.to - oldParagraph.from > 8192 || nextParagraph.to - nextParagraph.from > 8192
    || changes.mapPos(oldParagraph.from, -1) !== nextParagraph.from || changes.mapPos(oldParagraph.to, 1) !== nextParagraph.to
    || globalParagraphSyntax.test(before.doc.sliceString(oldParagraph.from, oldParagraph.to))
    || globalParagraphSyntax.test(doc.sliceString(nextParagraph.from, nextParagraph.to))
    || before.footnotes.definitions.some(definition => changes.touchesRange(definition.lineFrom, definition.lineTo))
    || before.blocks?.math.some(range => changes.touchesRange(range.from, range.to))
    || before.blocks?.details.some(block => changes.touchesRange(block.summaryFrom, block.summaryTo))
    || !hasSameLiveMarkdownOutsideBlock(before.tree, tree, changes, oldParagraph, nextParagraph)) return;
  const oldLiterals = collectMarkdownLiteralRanges(EditorState.create({ doc: before.doc }), before.tree, oldParagraph);
  const nextLiterals = collectMarkdownLiteralRanges(EditorState.create({ doc }), tree, nextParagraph);
  if (oldLiterals.some(range => changes.touchesRange(range.from, range.to)) || oldLiterals.length !== nextLiterals.length
    || oldLiterals.some((range, index) => {
      const next = nextLiterals[index]!;
      return changes.mapPos(range.from, 1) !== next.from || changes.mapPos(range.to, -1) !== next.to || range.script !== next.script
        || !!range.htmlCode !== !!next.htmlCode || range.htmlCode && (changes.mapPos(range.htmlCode.from, 1) !== next.htmlCode!.from
          || changes.mapPos(range.htmlCode.to, -1) !== next.htmlCode!.to);
    })) return;
  return mapUnchangedMarkdownDocumentContext(before, doc, tree, changes);
}
