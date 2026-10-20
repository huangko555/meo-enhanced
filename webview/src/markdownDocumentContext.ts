import { EditorState, type Text } from '@codemirror/state';
import type { Parser, Tree } from '@lezer/common';
import type { MarkdownCodeFence, MarkdownContextPart, ParsedFootnotes } from '../../src/foundation/markdownDocumentContext';
import { adoptFootnoteContext, parseFootnotes } from './helpers/footnotes';
import { adoptLiveBlockContext, prepareLiveBlockContext } from './helpers/liveRenderedBlocks';
import { withMarkdownSyntaxSnapshot } from './helpers/markdownSyntax';
import { adoptDetailsBlockContext, extractDetailsBlocks } from './helpers/markdownSyntax';
import { adoptDocumentMathRanges, collectDocumentMathRanges } from './helpers/displayMathBlocks';
import { adoptMarkdownLiteralRanges, collectMarkdownLiteralRanges } from './helpers/markdownLiteralRanges';
import { adoptCodeFenceSource, readCodeFenceSource } from './helpers/codeFenceSource';

/** A read-only worker context uses the completed outer tree. No View, history,
 * mounted language or DOM is constructed, and no EditorState crosses the wire. */
export function prepareMarkdownDocumentContext(doc: Text, tree: Tree, tabSize: number,
  known?: { footnotes: ParsedFootnotes; code: readonly MarkdownCodeFence[] }) {
  const state = EditorState.create({ doc, extensions: EditorState.tabSize.of(tabSize) });
  if (known) {
    adoptFootnoteContext(doc, tree, tabSize, known.footnotes, null);
    adoptCodeFenceSource(doc, tree, tabSize, known.code);
  }
  const primary = withMarkdownSyntaxSnapshot(state, tree, () => ({ footnotes: parseFootnotes(state), code: readCodeFenceSource(state, tree) }));
  return {
    ...primary,
    blocks: () => withMarkdownSyntaxSnapshot(state, tree, () => ({ blocks: prepareLiveBlockContext(state, tree),
      literals: [...collectMarkdownLiteralRanges(state, tree)], math: collectDocumentMathRanges(state, tree),
      details: extractDetailsBlocks(state, tree) }))
  };
}

/** Revision/grammar validation belongs to the worker owner. These source caches
 * are independent of selection, folding and HTML editing, which stay surface-owned. */
export function adoptMarkdownDocumentContext(doc: Text, tree: Tree, tabSize: number,
  part: MarkdownContextPart, parser: Parser): void {
  if (part.kind === 'footnotes') adoptFootnoteContext(doc, tree, tabSize, part.value, parser);
  else if (part.kind === 'code') adoptCodeFenceSource(doc, tree, tabSize, part.value);
  else {
    adoptLiveBlockContext(doc, tree, tabSize, part.value.blocks);
    adoptMarkdownLiteralRanges(tree, part.value.literals);
    adoptDocumentMathRanges(doc, tree, tabSize, part.value.math);
    adoptDetailsBlockContext(doc, tree, tabSize, part.value.details);
  }
}
