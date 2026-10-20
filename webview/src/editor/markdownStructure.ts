import { ParseContext, language, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import { NodeProp, Tree, type Parser, type ParseWrapper } from '@lezer/common';
import { usesLargeDocumentDerivedWorkBudget } from './liveInputDerivedWork';

const completeOuterMarkdown = new NodeProp<number>({ perNode: true });
const outerMarkdownIdentity = new NodeProp<Tree>({ perNode: true });
const preparedDocuments = new WeakMap<Text, Parser>();

/** Installed before mixed-code parsing. A full-length partial tree alone is
 * never a completeness proof; this mark requires the outer parser to finish. */
export const certifyMarkdownStructure: { wrap: ParseWrapper } = { wrap(inner, input, _fragments, ranges) {
  const owner = ParseContext.get()?.state;
  if (owner) preparedDocuments.delete(owner.doc);
  return {
    get parsedPos() { return inner.parsedPos; },
    get stoppedAt() { return inner.stoppedAt; },
    stopAt(position) { inner.stopAt(position); },
    advance() {
      const tree = inner.advance();
      const complete = !!tree && isCompleteMarkdownStructure(tree, input.length);
      if (!tree || tree.type.name !== 'Document' || !tree.type.isTop || tree.length !== input.length || inner.parsedPos < input.length
        || !complete && inner.stoppedAt !== null && inner.stoppedAt < input.length
        || ranges.length !== 1 || ranges[0]!.from !== 0 || ranges[0]!.to !== input.length) return tree;
      const context = ParseContext.get();
      const parser = context?.state.facet(language)?.parser;
      if (context && parser) preparedDocuments.set(context.state.doc, parser);
      if (complete) return tree;
      return new Tree(tree.type, tree.children, tree.positions, tree.length,
        [...tree.propValues, [completeOuterMarkdown, input.length], [outerMarkdownIdentity, tree]]);
    }
  };
} };

export function isCompleteMarkdownStructure(tree: Tree, length: number): boolean {
  return tree.length === length && tree.prop(completeOuterMarkdown) === length;
}

/** Mixed language publication preserves root props. Structural caches can use
 * the immutable outer identity without treating new code tokens as new Markdown. */
export function markdownStructureIdentity(tree: Tree): Tree {
  return tree.prop(outerMarkdownIdentity) ?? tree;
}

/** The background parser has completed this exact document revision. Wire
 * revision/grammar checks are owned by the receiver before calling this. */
export function acceptCompletedMarkdownStructure(tree: Tree, length: number): Tree {
  if (tree.length !== length || tree.type.name !== 'Document' || !tree.type.isTop) throw new Error('Incomplete background Markdown structure');
  return new Tree(tree.type, tree.children, tree.positions, length,
    [...tree.propValues, [completeOuterMarkdown, length], [outerMarkdownIdentity, tree]]);
}

export function markdownStructureAvailable(state: EditorState, tree: Tree = syntaxTree(state)): boolean {
  return isCompleteMarkdownStructure(tree, state.doc.length) || syntaxTreeAvailable(state, state.doc.length);
}

/** Preparation may finish the outer pass before CodeMirror publishes it. This
 * state-owned receipt requests publication; it never certifies a different tree. */
export function hasPreparedMarkdownStructure(state: EditorState): boolean {
  const parser = state.facet(language)?.parser;
  return !!parser && preparedDocuments.get(state.doc) === parser;
}

type Bounds = { readonly from: number; readonly to: number };
const preparationViewports = new WeakMap<Text, Bounds>();

/** ensureSyntaxTree temporarily widens ParseContext.viewport to its requested
 * endpoint. Structural preparation needs all Markdown, but only visible code. */
export function withMarkdownPreparationViewport<T>(state: EditorState, viewport: Bounds, read: () => T): T {
  const previous = preparationViewports.get(state.doc);
  preparationViewports.set(state.doc, viewport);
  try { return read(); }
  finally {
    if (previous) preparationViewports.set(state.doc, previous);
    else preparationViewports.delete(state.doc);
  }
}

/** Decline before mixed parsing materializes a packed node or creates a nested
 * job. Registering the whole host makes entering its source restart the parser. */
export function skipOffscreenMarkdownLanguage(context: ParseContext | null, from: number, to: number): boolean {
  if (!context || !usesLargeDocumentDerivedWorkBudget(context.state)) return false;
  const viewport = preparationViewports.get(context.state.doc) ?? context.viewport;
  if (to > viewport.from && from < viewport.to) return false;
  context.skipUntilInView(from, to);
  return true;
}
