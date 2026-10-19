import { Language, ParseContext, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { NodeProp, Parser, Tree, type Input, type ParseWrapper, type TreeFragment } from '@lezer/common';
import { usesLargeDocumentDerivedWorkBudget } from './liveInputDerivedWork';

const completeOuterMarkdown = new NodeProp<number>({ perNode: true });
const preparedStates = new WeakSet<EditorState>();

/** Installed before mixed-code parsing. A full-length partial tree alone is
 * never a completeness proof; this mark requires the outer parser to finish. */
export const certifyMarkdownStructure: { wrap: ParseWrapper } = { wrap(inner, input, _fragments, ranges) {
  const owner = ParseContext.get()?.state;
  if (owner) preparedStates.delete(owner);
  return {
    get parsedPos() { return inner.parsedPos; },
    get stoppedAt() { return inner.stoppedAt; },
    stopAt(position) { inner.stopAt(position); },
    advance() {
      const tree = inner.advance();
      if (!tree || tree.length !== input.length || inner.parsedPos < input.length
        || inner.stoppedAt !== null && inner.stoppedAt < input.length
        || ranges.length !== 1 || ranges[0]!.from !== 0 || ranges[0]!.to !== input.length) return tree;
      const context = ParseContext.get();
      if (context) preparedStates.add(context.state);
      return new Tree(tree.type, tree.children, tree.positions, tree.length,
        [...tree.propValues, [completeOuterMarkdown, input.length]]);
    }
  };
} };

export function isCompleteMarkdownStructure(tree: Tree, length: number): boolean {
  return tree.length === length && tree.prop(completeOuterMarkdown) === length;
}

export function markdownStructureAvailable(state: EditorState, tree: Tree = syntaxTree(state)): boolean {
  return isCompleteMarkdownStructure(tree, state.doc.length) || syntaxTreeAvailable(state, state.doc.length);
}

/** Preparation may finish the outer pass before CodeMirror publishes it. This
 * state-owned receipt requests publication; it never certifies a different tree. */
export function hasPreparedMarkdownStructure(state: EditorState): boolean {
  return preparedStates.has(state);
}

type Bounds = { readonly from: number; readonly to: number };
const preparationViewports = new WeakMap<EditorState, Bounds>();

/** ensureSyntaxTree temporarily widens ParseContext.viewport to its requested
 * endpoint. Structural preparation needs all Markdown, but only visible code. */
export function withMarkdownPreparationViewport<T>(state: EditorState, viewport: Bounds, read: () => T): T {
  const previous = preparationViewports.get(state);
  preparationViewports.set(state, viewport);
  try { return read(); }
  finally {
    if (previous) preparationViewports.set(state, previous);
    else preparationViewports.delete(state);
  }
}

class ViewportCodeParser extends Parser {
  constructor(private readonly parser: Parser) { super(); }

  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly Bounds[]) {
    const context = ParseContext.get();
    if (context && usesLargeDocumentDerivedWorkBudget(context.state)) {
      const viewport = preparationViewports.get(context.state) ?? context.viewport;
      if (ranges.length && ranges.every(range => range.to <= viewport.from || range.from >= viewport.to)) {
        for (const range of ranges) context.skipUntilInView(range.from, range.to);
        return ParseContext.getSkippingParser().startParse(input, fragments, ranges);
      }
    }
    return this.parser.startParse(input, fragments, ranges);
  }
}

const languages = new WeakMap<Language, Language>();

/** Preserve grammar and language data; CodeMirror's own viewport invalidation
 * reparses a skipped language when its source enters the editing viewport. */
export function viewportCodeLanguage(language: Language): Language {
  let bounded = languages.get(language);
  if (!bounded) {
    bounded = new Language(language.data, new ViewportCodeParser(language.parser), [], language.name);
    languages.set(language, bounded);
  }
  return bounded;
}
