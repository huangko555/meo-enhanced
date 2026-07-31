import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { DelimiterType, MarkdownConfig } from '@lezer/markdown';
import { resolvedSyntaxTree } from './markdownSyntax';

const HIGHLIGHT_MARKER_CODE = 61;
const highlightDelimiter: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' };

function isWhitespace(char: string): boolean {
  return /\s|^$/.test(char);
}

function isPunctuation(char: string): boolean {
  return char !== '' && /[\p{P}\p{S}]/u.test(char);
}

export const highlightMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    'Highlight',
    { name: 'HighlightMark', style: tags.processingInstruction }
  ],
  parseInline: [{
    name: 'Highlight',
    after: 'Emphasis',
    parse(context, next, pos) {
      if (
        next !== HIGHLIGHT_MARKER_CODE ||
        context.char(pos + 1) !== HIGHLIGHT_MARKER_CODE ||
        context.char(pos - 1) === HIGHLIGHT_MARKER_CODE ||
        context.char(pos + 2) === HIGHLIGHT_MARKER_CODE
      ) {
        return -1;
      }

      const before = context.slice(pos - 1, pos);
      const after = context.slice(pos + 2, pos + 3);
      const whitespaceBefore = isWhitespace(before);
      const whitespaceAfter = isWhitespace(after);
      const punctuationBefore = isPunctuation(before);
      const punctuationAfter = isPunctuation(after);
      const canOpen = !whitespaceAfter && (!punctuationAfter || whitespaceBefore || punctuationBefore);
      const canClose = !whitespaceBefore && (!punctuationBefore || whitespaceAfter || punctuationAfter);
      return context.addDelimiter(highlightDelimiter, pos, pos + 2, canOpen, canClose);
    }
  }]
};

const sourceHighlightDecoration = Decoration.mark({ class: 'meo-md-highlight' });

function buildSourceHighlightDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  resolvedSyntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Highlight' || node.to - node.from <= 4) return;
      builder.add(node.from + 2, node.to - 2, sourceHighlightDecoration);
    }
  });
  return builder.finish();
}

export const sourceHighlightField = StateField.define<DecorationSet>({
  create: buildSourceHighlightDecorations,
  update(decorations, transaction) {
    return transaction.docChanged ? buildSourceHighlightDecorations(transaction.state) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});
