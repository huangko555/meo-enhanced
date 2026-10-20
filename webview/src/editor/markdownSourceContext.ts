import type { ChangeDesc, Text } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import type { MarkdownSourceFacts } from '../../../src/foundation/markdownDocumentContext';
import { mapMarkdownContextCoordinates } from '../../../src/foundation/markdownContextCoordinates';

/** Owner-local completed revision. Text and Tree never cross the worker wire. */
export type MarkdownSourceContext = MarkdownSourceFacts & { readonly doc: Text; readonly tree: Tree; readonly tabSize: number };

/** Coordinate-only adoption. The worker owns the syntax proof, and the receiver
 * validates the exact base revision and composed changes before calling. */
export function mapUnchangedMarkdownDocumentContext(before: MarkdownSourceContext, doc: Text, tree: Tree,
  changes: ChangeDesc): MarkdownSourceContext {
  return { doc, tree, tabSize: before.tabSize, ...mapMarkdownContextCoordinates(before, changes) };
}
