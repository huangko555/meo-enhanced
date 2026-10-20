import { EditorState, type Text } from '@codemirror/state';
import type { Parser, Tree } from '@lezer/common';
import type { MarkdownContextPart } from '../../src/foundation/markdownDocumentContext';
import { adoptFootnoteContext, parseFootnotes } from './helpers/footnotes';
import { adoptLiveBlockContext, prepareLiveBlockContext } from './helpers/liveRenderedBlocks';
import { withMarkdownSyntaxSnapshot } from './helpers/markdownSyntax';

/** A read-only worker context uses the completed outer tree. No View, history,
 * mounted language or DOM is constructed, and no EditorState crosses the wire. */
export function prepareMarkdownDocumentContext(doc: Text, tree: Tree, tabSize: number) {
  const state = EditorState.create({ doc, extensions: EditorState.tabSize.of(tabSize) });
  return {
    footnotes: withMarkdownSyntaxSnapshot(state, tree, () => parseFootnotes(state)),
    blocks: () => prepareLiveBlockContext(state, tree)
  };
}

/** Revision/grammar validation belongs to the worker owner. These source caches
 * are independent of selection, folding and HTML editing, which stay surface-owned. */
export function adoptMarkdownDocumentContext(doc: Text, tree: Tree, tabSize: number,
  part: MarkdownContextPart, parser: Parser): void {
  if (part.kind === 'footnotes') adoptFootnoteContext(doc, tree, tabSize, part.value, parser);
  else adoptLiveBlockContext(doc, tree, tabSize, part.value);
}
